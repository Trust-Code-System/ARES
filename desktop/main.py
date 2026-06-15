"""ARES cross-platform PySide6 desktop HUD client."""

from __future__ import annotations

import io
import json
import math
import os
import sys
import tempfile
import wave
from pathlib import Path

import requests
from PySide6.QtCore import QObject, QPointF, Qt, QThread, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QRadialGradient
from PySide6.QtMultimedia import (
    QAudioFormat,
    QAudioOutput,
    QAudioSource,
    QMediaDevices,
    QMediaPlayer,
)
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QSplitter,
    QVBoxLayout,
    QWidget,
)


API_BASE = os.environ.get("ARES_API_URL", "http://127.0.0.1:3001").rstrip("/")
MODES = ("general", "developer", "research", "business", "project", "document", "hr", "communications")


class ApiWorker(QObject):
    token = Signal(str)
    activity = Signal(str)
    finished = Signal(str)
    failed = Signal(str)

    def __init__(self, text: str, mode: str) -> None:
        super().__init__()
        self.text = text
        self.mode = mode

    @Slot()
    def run(self) -> None:
        answer: list[str] = []
        event_name = ""
        try:
            with requests.post(
                f"{API_BASE}/api/chat/stream",
                json={"text": self.text, "mode": self.mode},
                stream=True,
                timeout=(5, 180),
            ) as response:
                response.raise_for_status()
                for raw in response.iter_lines(chunk_size=1, decode_unicode=True):
                    line = raw or ""
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                    elif line.startswith("data:"):
                        payload = json.loads(line[5:].strip())
                        if event_name == "token":
                            value = str(payload.get("token", ""))
                            answer.append(value)
                            self.token.emit(value)
                        elif event_name == "activity":
                            events = payload.get("events") or []
                            if events:
                                latest = events[-1]
                                self.activity.emit(
                                    f"{latest.get('type', 'event').upper()}  "
                                    f"{json.dumps(latest.get('detail', {}), ensure_ascii=True)}"
                                )
                        elif event_name == "error":
                            raise RuntimeError(payload.get("error", "ARES stream failed"))
            self.finished.emit("".join(answer).strip())
        except Exception as exc:  # UI boundary: report all transport failures.
            self.failed.emit(str(exc))


class TranscriptionWorker(QObject):
    finished = Signal(str)
    failed = Signal(str)

    def __init__(self, wav_data: bytes) -> None:
        super().__init__()
        self.wav_data = wav_data

    @Slot()
    def run(self) -> None:
        try:
            response = requests.post(
                f"{API_BASE}/api/voice/transcribe",
                data=self.wav_data,
                headers={"content-type": "audio/wav"},
                timeout=120,
            )
            response.raise_for_status()
            self.finished.emit(str(response.json().get("text", "")).strip())
        except Exception as exc:
            self.failed.emit(str(exc))


class SpeechWorker(QObject):
    finished = Signal(str)
    failed = Signal(str)

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text

    @Slot()
    def run(self) -> None:
        try:
            response = requests.post(
                f"{API_BASE}/api/voice/speak",
                json={"text": self.text},
                timeout=120,
            )
            response.raise_for_status()
            suffix = ".mp3" if "mpeg" in response.headers.get("content-type", "") else ".audio"
            handle = tempfile.NamedTemporaryFile(prefix="ares-speech-", suffix=suffix, delete=False)
            handle.write(response.content)
            handle.close()
            self.finished.emit(handle.name)
        except Exception as exc:
            self.failed.emit(str(exc))


class StatusWorker(QObject):
    finished = Signal(dict)
    failed = Signal(str)

    @Slot()
    def run(self) -> None:
        try:
            response = requests.get(f"{API_BASE}/api/status", timeout=4)
            response.raise_for_status()
            self.finished.emit(response.json())
        except Exception as exc:
            self.failed.emit(str(exc))


class AudioRecorder(QObject):
    def __init__(self) -> None:
        super().__init__()
        self.source: QAudioSource | None = None
        self.device = None
        self.chunks: list[bytes] = []
        self.format = QAudioFormat()
        self.format.setSampleRate(16000)
        self.format.setChannelCount(1)
        self.format.setSampleFormat(QAudioFormat.SampleFormat.Int16)

    def start(self) -> None:
        self.chunks.clear()
        device = QMediaDevices.defaultAudioInput()
        if device.isNull():
            raise RuntimeError("No audio input device is available.")
        if not device.isFormatSupported(self.format):
            self.format = device.preferredFormat()
        self.source = QAudioSource(device, self.format)
        self.device = self.source.start()
        self.device.readyRead.connect(self._read)

    def stop(self) -> bytes:
        if not self.source:
            return b""
        self._read()
        self.source.stop()
        self.source.deleteLater()
        self.source = None
        self.device = None
        raw = b"".join(self.chunks)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(self.format.channelCount())
            wav.setsampwidth(self.format.bytesPerSample())
            wav.setframerate(self.format.sampleRate())
            wav.writeframes(raw)
        return output.getvalue()

    def _read(self) -> None:
        if self.device:
            self.chunks.append(bytes(self.device.readAll()))


class AvatarWidget(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.state = "idle"
        self.phase = 0.0
        self.setMinimumSize(280, 280)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.timer.start(16)

    def set_state(self, state: str) -> None:
        self.state = state
        self.update()

    def _tick(self) -> None:
        speed = 0.10 if self.state in {"thinking", "speaking", "listening"} else 0.035
        self.phase = (self.phase + speed) % (math.pi * 2)
        self.update()

    def paintEvent(self, _event) -> None:  # noqa: N802 - Qt override
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        center = QPointF(self.width() / 2, self.height() / 2)
        base = min(self.width(), self.height()) * 0.31
        color = QColor("#ff334f") if self.state == "error" else QColor("#00d9ff")
        if self.state == "listening":
            color = QColor("#36ff9a")
        elif self.state == "speaking":
            color = QColor("#ff9f1c")
        pulse = 1.0 + (0.08 if self.state in {"thinking", "speaking", "listening"} else 0.025) * math.sin(self.phase * 2)

        glow = QRadialGradient(center, base * 1.45)
        glow.setColorAt(0.0, QColor(color.red(), color.green(), color.blue(), 150))
        glow.setColorAt(0.35, QColor(color.red(), color.green(), color.blue(), 45))
        glow.setColorAt(1.0, QColor(0, 0, 0, 0))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(glow)
        painter.drawEllipse(center, base * 1.5 * pulse, base * 1.5 * pulse)

        painter.setBrush(Qt.BrushStyle.NoBrush)
        for index in range(5):
            radius = base * (0.45 + index * 0.19) * pulse
            alpha = 235 - index * 34
            pen = QPen(QColor(color.red(), color.green(), color.blue(), alpha), 2 if index < 2 else 1)
            painter.setPen(pen)
            painter.drawEllipse(center, radius, radius * (0.48 + index * 0.055))

        painter.save()
        painter.translate(center)
        painter.rotate(math.degrees(self.phase))
        for index in range(12):
            angle = index * math.pi / 6
            x = math.cos(angle) * base * 1.08
            y = math.sin(angle) * base * 0.57
            size = 3 + 2 * math.sin(self.phase + index)
            painter.setBrush(color)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawEllipse(QPointF(x, y), size, size)
        painter.restore()

        painter.setPen(QPen(color, 2))
        painter.setBrush(QColor(color.red(), color.green(), color.blue(), 35))
        painter.drawEllipse(center, base * 0.31 * pulse, base * 0.31 * pulse)
        painter.setFont(QFont("Consolas", 13, QFont.Weight.Bold))
        painter.drawText(
            int(center.x() - base),
            int(center.y() - 12),
            int(base * 2),
            24,
            Qt.AlignmentFlag.AlignCenter,
            self.state.upper(),
        )


class MainWindow(QMainWindow):
    def __init__(self, check_status: bool = True) -> None:
        super().__init__()
        self.setWindowTitle("ARES Desktop Command Center")
        self.resize(1240, 820)
        self.threads: list[QThread] = []
        self.lines: list[str] = []
        self.answer_index = -1
        self.answer_text = ""
        self.recording = False
        self.recorder = AudioRecorder()
        self.audio_output = QAudioOutput(self)
        self.player = QMediaPlayer(self)
        self.player.setAudioOutput(self.audio_output)
        self.player.playbackStateChanged.connect(self._playback_state)
        self.current_audio_path: str | None = None
        self._build_ui()
        self._apply_style()

        if check_status:
            self.status_timer = QTimer(self)
            self.status_timer.timeout.connect(self.refresh_status)
            self.status_timer.start(5000)
            self.refresh_status()

    def _build_ui(self) -> None:
        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(22, 18, 22, 18)
        layout.setSpacing(14)

        header = QHBoxLayout()
        brand = QLabel("A R E S")
        brand.setObjectName("brand")
        subtitle = QLabel("AUTONOMOUS REASONING & EXECUTION SYSTEM / DESKTOP")
        subtitle.setObjectName("subtle")
        header.addWidget(brand)
        header.addSpacing(14)
        header.addWidget(subtitle)
        header.addStretch()
        self.connection = QLabel("API LINK / SCANNING")
        self.connection.setObjectName("status")
        header.addWidget(self.connection)
        layout.addLayout(header)

        divider = QFrame()
        divider.setFrameShape(QFrame.Shape.HLine)
        layout.addWidget(divider)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        left_layout = QVBoxLayout(left)
        self.avatar = AvatarWidget()
        left_layout.addWidget(self.avatar, 2)
        self.telemetry = QLabel("PROVIDER -- / MODEL -- / VOICE --")
        self.telemetry.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.telemetry.setObjectName("telemetry")
        left_layout.addWidget(self.telemetry)
        self.activity = QPlainTextEdit()
        self.activity.setReadOnly(True)
        self.activity.setPlaceholderText("LIVE TOOL AND SAFETY TELEMETRY")
        left_layout.addWidget(self.activity, 1)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        controls = QHBoxLayout()
        controls.addWidget(QLabel("MODE"))
        self.mode = QComboBox()
        self.mode.addItems(MODES)
        controls.addWidget(self.mode)
        self.auto_speak = QCheckBox("AUTO VOICE")
        self.auto_speak.setChecked(True)
        controls.addWidget(self.auto_speak)
        self.interrupt = QPushButton("INTERRUPT")
        self.interrupt.clicked.connect(self.stop_speaking)
        controls.addWidget(self.interrupt)
        controls.addStretch()
        right_layout.addLayout(controls)

        self.transcript = QPlainTextEdit()
        self.transcript.setReadOnly(True)
        self.transcript.setPlaceholderText("COMMUNICATION CHANNEL READY")
        right_layout.addWidget(self.transcript, 1)

        composer = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("Command ARES...")
        self.input.returnPressed.connect(self.send_message)
        composer.addWidget(self.input, 1)
        self.mic = QPushButton("PUSH TO TALK")
        self.mic.clicked.connect(self.toggle_recording)
        composer.addWidget(self.mic)
        self.send = QPushButton("TRANSMIT")
        self.send.clicked.connect(self.send_message)
        composer.addWidget(self.send)
        right_layout.addLayout(composer)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([430, 760])
        layout.addWidget(splitter, 1)
        self.setCentralWidget(root)

    def _apply_style(self) -> None:
        self.setStyleSheet(
            """
            QWidget { background: #02080d; color: #d7e8ef; font-family: "Segoe UI", "DejaVu Sans", sans-serif; }
            QMainWindow { background: #01060a; }
            QLabel#brand { color: #00d9ff; font: 700 22px "Consolas", "DejaVu Sans Mono", monospace; letter-spacing: 6px; }
            QLabel#subtle, QLabel#telemetry { color: #7193a2; font: 10px "Consolas", "DejaVu Sans Mono", monospace; letter-spacing: 2px; }
            QLabel#status { color: #36ff9a; font: 11px "Consolas", "DejaVu Sans Mono", monospace; }
            QFrame { color: #0b5668; }
            QPlainTextEdit, QLineEdit, QComboBox {
                background: #031019; border: 1px solid #0b5668; color: #d7e8ef;
                selection-background-color: #0b5668; padding: 9px; font: 12px "Consolas", "DejaVu Sans Mono", monospace;
            }
            QPlainTextEdit:focus, QLineEdit:focus, QComboBox:focus { border-color: #00d9ff; }
            QPushButton {
                background: #04202b; border: 1px solid #00a7c7; color: #00d9ff;
                padding: 10px 16px; font: 700 10px "Consolas", "DejaVu Sans Mono", monospace; letter-spacing: 1px;
            }
            QPushButton:hover { background: #083442; border-color: #00d9ff; }
            QPushButton:disabled { color: #3d5964; border-color: #17333d; }
            QCheckBox { color: #ff9f1c; font: 10px "Consolas", "DejaVu Sans Mono", monospace; spacing: 8px; }
            QSplitter::handle { background: #0b5668; width: 1px; }
            """
        )

    @Slot()
    def refresh_status(self) -> None:
        worker = StatusWorker()
        worker.finished.connect(self._status_ready)
        worker.failed.connect(lambda _message: self._status_failed())
        self._start_worker(worker)

    @Slot(dict)
    def _status_ready(self, status: dict) -> None:
        self.connection.setText("API LINK / ONLINE")
        provider = str(status.get("provider", "--")).upper()
        model = str(status.get("model", "--")).upper()
        stt = str(status.get("voiceInputProvider") or "--").upper()
        tts = str(status.get("voiceOutputProvider") or "--").upper()
        self.telemetry.setText(f"PROVIDER {provider} / MODEL {model} / STT {stt} / TTS {tts}")

    def _status_failed(self) -> None:
        self.connection.setText("API LINK / OFFLINE")

    @Slot()
    def send_message(self, text: str | None = None) -> None:
        prompt = (text if text is not None else self.input.text()).strip()
        if not prompt:
            return
        self.stop_speaking()
        self.input.clear()
        self.lines.extend([f"YOU > {prompt}", "ARES > "])
        self.answer_index = len(self.lines) - 1
        self.answer_text = ""
        self._render_transcript()
        self._set_busy(True)
        self.avatar.set_state("thinking")

        worker = ApiWorker(prompt, self.mode.currentText())
        worker.token.connect(self._append_token)
        worker.activity.connect(self._append_activity)
        worker.finished.connect(self._answer_finished)
        worker.failed.connect(self._request_failed)
        self._start_worker(worker)

    @Slot(str)
    def _append_token(self, token: str) -> None:
        self.answer_text += token
        if self.answer_index >= 0:
            self.lines[self.answer_index] = f"ARES > {self.answer_text}"
        self._render_transcript()

    @Slot(str)
    def _append_activity(self, line: str) -> None:
        self.activity.appendPlainText(line)

    @Slot(str)
    def _answer_finished(self, answer: str) -> None:
        self._set_busy(False)
        self.avatar.set_state("idle")
        final = answer or self.answer_text
        if final and self.auto_speak.isChecked():
            self.speak(final)

    @Slot(str)
    def _request_failed(self, message: str) -> None:
        self._set_busy(False)
        self.avatar.set_state("error")
        if self.answer_index >= 0:
            self.lines[self.answer_index] = f"ARES > SYSTEM ERROR: {message}"
        self._render_transcript()

    @Slot()
    def toggle_recording(self) -> None:
        if self.recording:
            wav_data = self.recorder.stop()
            self.recording = False
            self.mic.setText("PUSH TO TALK")
            self.avatar.set_state("thinking")
            worker = TranscriptionWorker(wav_data)
            worker.finished.connect(self._transcript_ready)
            worker.failed.connect(self._request_failed)
            self._start_worker(worker)
            return
        try:
            self.stop_speaking()
            self.recorder.start()
            self.recording = True
            self.mic.setText("STOP / SEND")
            self.avatar.set_state("listening")
        except Exception as exc:
            self._request_failed(str(exc))

    @Slot(str)
    def _transcript_ready(self, text: str) -> None:
        if text:
            self.send_message(text)
        else:
            self._request_failed("No speech was detected.")

    def speak(self, text: str) -> None:
        self.avatar.set_state("thinking")
        worker = SpeechWorker(text)
        worker.finished.connect(self._play_audio)
        worker.failed.connect(self._request_failed)
        self._start_worker(worker)

    @Slot(str)
    def _play_audio(self, path: str) -> None:
        self.stop_speaking()
        self.current_audio_path = path
        self.player.setSource(QUrl.fromLocalFile(path))
        self.player.play()
        self.avatar.set_state("speaking")

    @Slot()
    def stop_speaking(self) -> None:
        self.player.stop()
        self.avatar.set_state("idle")
        if self.current_audio_path:
            try:
                Path(self.current_audio_path).unlink(missing_ok=True)
            except OSError:
                pass
            self.current_audio_path = None

    @Slot()
    def _playback_state(self, state) -> None:
        if state == QMediaPlayer.PlaybackState.StoppedState and self.avatar.state == "speaking":
            self.stop_speaking()

    def _render_transcript(self) -> None:
        self.transcript.setPlainText("\n\n".join(self.lines))
        scrollbar = self.transcript.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _set_busy(self, busy: bool) -> None:
        self.send.setDisabled(busy)
        self.input.setDisabled(busy)
        self.mode.setDisabled(busy)

    def _start_worker(self, worker: QObject) -> None:
        thread = QThread(self)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        for signal_name in ("finished", "failed"):
            signal = getattr(worker, signal_name, None)
            if signal is not None:
                signal.connect(thread.quit)
        thread.finished.connect(worker.deleteLater)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(lambda: self.threads.remove(thread) if thread in self.threads else None)
        self.threads.append(thread)
        thread.start()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self.recording:
            self.recorder.stop()
        self.stop_speaking()
        super().closeEvent(event)


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("ARES")
    screenshot_mode = "--screenshot" in sys.argv
    window = MainWindow(check_status=not screenshot_mode)
    window.show()

    if screenshot_mode:
        index = sys.argv.index("--screenshot")
        output = Path(sys.argv[index + 1] if len(sys.argv) > index + 1 else "ares-desktop.png")

        def capture() -> None:
            output.parent.mkdir(parents=True, exist_ok=True)
            window.grab().save(str(output))
            window.close()
            app.quit()

        QTimer.singleShot(1200, capture)

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
