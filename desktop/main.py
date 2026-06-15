"""ARES cross-platform PySide6 desktop HUD client."""

from __future__ import annotations

import array
import io
import json
import math
import os
import re
import sys
import tempfile
import wave
from collections import deque
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


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# --- Voice-activity-detection tuning ------------------------------------------
# All times are milliseconds. The thresholds are *relative to a continuously
# measured noise floor*, so a steady fan/AC hum is learned as "silence" and your
# voice — which rises well above it — still triggers. Override via env vars.
VAD_FRAME_MS = 30
# How long after you stop talking before the turn is considered finished. Long
# enough to ride out natural pauses ("um…", breaths) so it lets you finish.
VAD_SILENCE_MS = _env_int("ARES_VAD_SILENCE_MS", 900)
# Consecutive voiced time needed to latch on — rejects keyboard clicks/pops.
VAD_ONSET_MS = _env_int("ARES_VAD_ONSET_MS", 120)
# Audio kept *before* onset so the first word is never clipped ("pick up instantly").
VAD_PREROLL_MS = _env_int("ARES_VAD_PREROLL_MS", 320)
# Utterances shorter than this are discarded as noise, not sent for transcription.
VAD_MIN_UTTERANCE_MS = _env_int("ARES_VAD_MIN_MS", 350)
VAD_MAX_UTTERANCE_MS = _env_int("ARES_VAD_MAX_MS", 30_000)
# Higher sensitivity → lower thresholds → picks up quieter speech (more false fires).
VAD_SENSITIVITY = max(0.3, _env_float("ARES_VAD_SENSITIVITY", 1.0))
# Speech must exceed noise_floor * ON_RATIO to start; drops below * OFF_RATIO to end.
VAD_ON_RATIO = max(1.6, 3.2 / VAD_SENSITIVITY)
VAD_OFF_RATIO = max(1.2, 1.8 / VAD_SENSITIVITY)
# Absolute floor (normalised RMS) so dead-quiet rooms don't trigger on noise.
VAD_ABS_MIN = 0.012 / VAD_SENSITIVITY
# How fast the noise floor tracks ambient changes while no one is speaking.
VAD_FLOOR_ADAPT = 0.04


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


class VadRecorder(QObject):
    """
    Continuous microphone capture with energy-based voice-activity detection.

    Two jobs:
      * **Hands-free listening** (``start_vad``): runs forever, learns the ambient
        noise floor (so a fan/AC hum reads as silence), starts capturing the moment
        your voice rises above it — keeping a pre-roll so the first word isn't
        clipped — and emits a finished utterance only after a sustained silence, so
        brief pauses don't cut you off mid-thought.
      * **Push-to-talk** (``start_manual``): captures everything until ``stop``.

    Energy thresholds are *relative to the live noise floor*, which is what makes it
    robust to constant background noise rather than a fixed cutoff.
    """

    utterance = Signal(bytes)
    speech_started = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.source: QAudioSource | None = None
        self.device = None
        self.listening = False
        self.manual = False
        self.format = QAudioFormat()
        self.format.setSampleRate(16000)
        self.format.setChannelCount(1)
        self.format.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self._buf = bytearray()
        self._reset_state()

    def _reset_state(self) -> None:
        self._frame_bytes = 0
        self._frame_ms = VAD_FRAME_MS
        self._preroll: deque[bytes] = deque()
        self._captured: list[bytes] = []
        self._in_speech = False
        self._onset_ms = 0
        self._silence_ms = 0
        self._noise_floor = 0.01
        self._calibrating = 0
        self._emitted = False

    # -- lifecycle -------------------------------------------------------------
    def start_vad(self) -> None:
        self._open(manual=False)

    def start_manual(self) -> None:
        self._open(manual=True)

    def _open(self, manual: bool) -> None:
        if self.listening:
            return
        device = QMediaDevices.defaultAudioInput()
        if device.isNull():
            raise RuntimeError("No audio input device is available.")
        fmt = QAudioFormat()
        fmt.setSampleRate(16000)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        if not device.isFormatSupported(fmt):
            fmt = device.preferredFormat()
        self.format = fmt
        self._buf.clear()
        self._reset_state()
        self.manual = manual
        bytes_per_sample = max(1, self.format.bytesPerSample())
        frame_samples = max(1, int(self.format.sampleRate() * self._frame_ms / 1000))
        self._frame_bytes = frame_samples * bytes_per_sample * max(1, self.format.channelCount())
        self._preroll = deque(maxlen=max(1, VAD_PREROLL_MS // self._frame_ms))
        self._calibrating = max(3, 300 // self._frame_ms)
        self.source = QAudioSource(device, self.format)
        self.device = self.source.start()
        self.device.readyRead.connect(self._read)
        self.listening = True

    def stop(self) -> bytes:
        """Stop capture. In manual mode, return the recorded audio as WAV bytes."""
        if not self.listening:
            return b""
        self._read()
        captured = b"".join(self._captured) if self.manual else b""
        if self.source:
            self.source.stop()
            self.source.deleteLater()
        self.source = None
        self.device = None
        self.listening = False
        self._buf.clear()
        self._captured = []
        return self._to_wav(captured) if captured else b""

    # -- capture loop ----------------------------------------------------------
    def _read(self) -> None:
        if not self.device:
            return
        self._buf.extend(bytes(self.device.readAll()))
        fb = self._frame_bytes
        if fb <= 0:
            return
        while len(self._buf) >= fb:
            frame = bytes(self._buf[:fb])
            del self._buf[:fb]
            if self.manual:
                self._captured.append(frame)
            else:
                self._process_frame(frame)

    def _process_frame(self, frame: bytes) -> None:
        if self._emitted:
            return
        rms = self._rms(frame)
        self._preroll.append(frame)

        if self._calibrating > 0:
            self._noise_floor = max(VAD_ABS_MIN, (self._noise_floor + rms) / 2)
            self._calibrating -= 1
            return

        on_threshold = max(self._noise_floor * VAD_ON_RATIO, VAD_ABS_MIN)
        off_threshold = max(self._noise_floor * VAD_OFF_RATIO, VAD_ABS_MIN * 0.6)

        if not self._in_speech:
            # Track ambient level while quiet so the fan's hum stays "silence".
            if rms < on_threshold:
                self._noise_floor = (1 - VAD_FLOOR_ADAPT) * self._noise_floor + VAD_FLOOR_ADAPT * rms
                self._onset_ms = 0
            else:
                self._onset_ms += self._frame_ms
                if self._onset_ms >= VAD_ONSET_MS:
                    self._in_speech = True
                    self._silence_ms = 0
                    self._captured = list(self._preroll)  # pre-roll includes this frame
                    self.speech_started.emit()
            return

        self._captured.append(frame)
        if rms >= off_threshold:
            self._silence_ms = 0
        else:
            self._silence_ms += self._frame_ms
            if self._silence_ms >= VAD_SILENCE_MS:
                self._finish_utterance()
                return
        if len(self._captured) * self._frame_ms >= VAD_MAX_UTTERANCE_MS:
            self._finish_utterance()

    def _finish_utterance(self) -> None:
        frames = self._captured
        self._captured = []
        self._in_speech = False
        self._onset_ms = 0
        self._silence_ms = 0
        # Drop the trailing hangover of pure silence before transcribing.
        speech_ms = max(0, len(frames) * self._frame_ms - VAD_SILENCE_MS)
        if speech_ms < VAD_MIN_UTTERANCE_MS:
            return  # too short to be real speech — keep listening
        self._emitted = True  # ignore further frames until the host stops/restarts us
        self.utterance.emit(self._to_wav(b"".join(frames)))

    # -- helpers ---------------------------------------------------------------
    def _rms(self, frame: bytes) -> float:
        sf = self.format.sampleFormat()
        try:
            if sf == QAudioFormat.SampleFormat.Int16:
                samples = array.array("h")
                samples.frombytes(frame[: len(frame) - len(frame) % 2])
                if not samples:
                    return 0.0
                return math.sqrt(sum(v * v for v in samples) / len(samples)) / 32768.0
            if sf == QAudioFormat.SampleFormat.Float:
                samples = array.array("f")
                samples.frombytes(frame[: len(frame) - len(frame) % 4])
                if not samples:
                    return 0.0
                return math.sqrt(sum(v * v for v in samples) / len(samples))
            if sf == QAudioFormat.SampleFormat.Int32:
                samples = array.array("i")
                samples.frombytes(frame[: len(frame) - len(frame) % 4])
                if not samples:
                    return 0.0
                return math.sqrt(sum((v / 2147483648.0) ** 2 for v in samples) / len(samples))
            if sf == QAudioFormat.SampleFormat.UInt8:
                if not frame:
                    return 0.0
                return math.sqrt(sum((b - 128) ** 2 for b in frame) / len(frame)) / 128.0
        except (ValueError, ZeroDivisionError):
            return 0.0
        return 0.0

    def _to_wav(self, raw: bytes) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(self.format.channelCount())
            wav.setsampwidth(self.format.bytesPerSample())
            wav.setframerate(self.format.sampleRate())
            wav.writeframes(raw)
        return output.getvalue()


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
        self.recording = False  # manual push-to-talk in progress
        self.responding = False  # a turn is being transcribed/answered/spoken
        self.answer_done = False  # the model has finished streaming this turn
        self.recorder = VadRecorder()
        self.recorder.utterance.connect(self._on_utterance)
        self.audio_output = QAudioOutput(self)
        self.player = QMediaPlayer(self)
        self.player.setAudioOutput(self.audio_output)
        self.player.mediaStatusChanged.connect(self._media_status)
        # Streaming TTS: sentences awaiting synthesis, audio files awaiting playback.
        self._speak_queue: list[str] = []
        self._audio_queue: list[str] = []
        self._synth_busy = False
        self._current_audio: str | None = None
        self._tts_pending = ""  # partial sentence accumulated from streamed tokens
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
        self.hands_free = QCheckBox("HANDS-FREE")
        self.hands_free.setToolTip("Listen continuously and reply automatically — no clicking.")
        self.hands_free.toggled.connect(self._toggle_hands_free)
        controls.addWidget(self.hands_free)
        self.auto_speak = QCheckBox("AUTO VOICE")
        self.auto_speak.setChecked(True)
        controls.addWidget(self.auto_speak)
        self.interrupt = QPushButton("INTERRUPT")
        self.interrupt.clicked.connect(self.barge_in)
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

    # -- hands-free listening --------------------------------------------------
    @Slot(bool)
    def _toggle_hands_free(self, _enabled: bool) -> None:
        self._update_listening()

    def _update_listening(self) -> None:
        """Single source of truth for whether the VAD mic should be running."""
        should_listen = (
            self.hands_free.isChecked()
            and not self.responding
            and not self.recording
            and self._current_audio is None
        )
        if should_listen and not self.recorder.listening:
            try:
                self.recorder.start_vad()
                self.avatar.set_state("listening")
            except Exception as exc:
                self.hands_free.setChecked(False)
                self._request_failed(str(exc))
        elif not should_listen and self.recorder.listening and not self.recording:
            self.recorder.stop()
            if self.avatar.state == "listening":
                self.avatar.set_state("idle")

    @Slot(bytes)
    def _on_utterance(self, wav_data: bytes) -> None:
        # A complete hands-free utterance arrived. Stop the mic and answer it.
        if self.responding or self.recording:
            return
        self.recorder.stop()
        if not wav_data:
            self._update_listening()
            return
        self.responding = True
        self.avatar.set_state("thinking")
        worker = TranscriptionWorker(wav_data)
        worker.finished.connect(self._transcript_ready)
        worker.failed.connect(self._request_failed)
        self._start_worker(worker)

    @Slot()
    def send_message(self, text: str | None = None) -> None:
        prompt = (text if text is not None else self.input.text()).strip()
        if not prompt:
            return
        self._reset_speech()
        self.input.clear()
        self.responding = True
        self.answer_done = False
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
        self._feed_speech(token)

    @Slot(str)
    def _append_activity(self, line: str) -> None:
        self.activity.appendPlainText(line)

    @Slot(str)
    def _answer_finished(self, answer: str) -> None:
        self._set_busy(False)
        self.answer_done = True
        final = answer or self.answer_text
        if self.auto_speak.isChecked():
            # Flush whatever sentence fragment is still buffered, then let the
            # playback queue drain and resume listening when it's empty.
            self._flush_speech()
            self._check_done()
        else:
            self.responding = False
            self.avatar.set_state("idle")
            self._update_listening()

    @Slot(str)
    def _request_failed(self, message: str) -> None:
        self._set_busy(False)
        self.responding = False
        self.answer_done = True
        self.avatar.set_state("error")
        if self.answer_index >= 0:
            self.lines[self.answer_index] = f"ARES > SYSTEM ERROR: {message}"
        self._render_transcript()
        # After surfacing the error, pick listening back up if hands-free is on.
        QTimer.singleShot(1200, self._update_listening)

    @Slot()
    def toggle_recording(self) -> None:
        if self.recording:
            wav_data = self.recorder.stop()
            self.recording = False
            self.mic.setText("PUSH TO TALK")
            self.responding = True
            self.avatar.set_state("thinking")
            worker = TranscriptionWorker(wav_data)
            worker.finished.connect(self._transcript_ready)
            worker.failed.connect(self._request_failed)
            self._start_worker(worker)
            return
        try:
            self.barge_in()
            if self.recorder.listening:
                self.recorder.stop()  # drop hands-free VAD; manual takes the mic
            self.recorder.start_manual()
            self.recording = True
            self.mic.setText("STOP / SEND")
            self.avatar.set_state("listening")
        except Exception as exc:
            self.recording = False
            self._request_failed(str(exc))

    @Slot(str)
    def _transcript_ready(self, text: str) -> None:
        if text:
            self.send_message(text)
        else:
            # Nothing intelligible — don't error out in hands-free, just listen again.
            self.responding = False
            if self.hands_free.isChecked():
                self.avatar.set_state("idle")
                self._update_listening()
            else:
                self._request_failed("No speech was detected.")

    # -- streaming text-to-speech ---------------------------------------------
    def _feed_speech(self, token: str) -> None:
        """Accumulate streamed tokens and emit complete sentences to be spoken."""
        if not self.auto_speak.isChecked():
            return
        self._tts_pending += token
        sentences, self._tts_pending = _split_sentences(self._tts_pending)
        for sentence in sentences:
            self._enqueue_speech(sentence)

    def _flush_speech(self) -> None:
        remainder = self._tts_pending.strip()
        self._tts_pending = ""
        if remainder:
            self._enqueue_speech(remainder)

    def _enqueue_speech(self, sentence: str) -> None:
        spoken = _clean_for_speech(sentence)
        if not spoken:
            return
        self._speak_queue.append(spoken)
        self._pump_synth()

    def _pump_synth(self) -> None:
        # Synthesize one sentence at a time; the next is prepared while the current
        # one plays, so the first words are heard almost immediately.
        if self._synth_busy or not self._speak_queue:
            return
        sentence = self._speak_queue.pop(0)
        self._synth_busy = True
        worker = SpeechWorker(sentence)
        worker.finished.connect(self._synth_done)
        worker.failed.connect(self._synth_failed)
        self._start_worker(worker)

    @Slot(str)
    def _synth_done(self, path: str) -> None:
        self._synth_busy = False
        self._audio_queue.append(path)
        self._play_next()
        self._pump_synth()
        self._check_done()

    @Slot(str)
    def _synth_failed(self, message: str) -> None:
        self._synth_busy = False
        self.activity.appendPlainText(f"TTS ERROR  {message}")
        self._pump_synth()
        self._check_done()

    def _play_next(self) -> None:
        if self._current_audio is not None or not self._audio_queue:
            return
        path = self._audio_queue.pop(0)
        self._current_audio = path
        self.player.setSource(QUrl.fromLocalFile(path))
        self.player.play()
        self.avatar.set_state("speaking")

    @Slot()
    def _media_status(self, status) -> None:
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self._drop_current_audio()
            self._play_next()
            self._check_done()

    def _drop_current_audio(self) -> None:
        if self._current_audio:
            try:
                Path(self._current_audio).unlink(missing_ok=True)
            except OSError:
                pass
            self._current_audio = None

    def _check_done(self) -> None:
        """When the answer is fully spoken, return to idle/listening."""
        if not self.responding or not self.answer_done:
            return
        if self._speak_queue or self._audio_queue or self._synth_busy or self._current_audio:
            return
        self.responding = False
        self.avatar.set_state("idle")
        self._update_listening()

    def _reset_speech(self) -> None:
        self.player.stop()
        self._drop_current_audio()
        for path in self._audio_queue:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass
        self._audio_queue.clear()
        self._speak_queue.clear()
        self._synth_busy = False
        self._tts_pending = ""

    @Slot()
    def barge_in(self) -> None:
        """Stop speaking immediately and (if hands-free) start listening again."""
        self._reset_speech()
        self.answer_done = True
        self.responding = False
        if self.avatar.state in {"speaking", "thinking"}:
            self.avatar.set_state("idle")
        self._update_listening()

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
        if self.recorder.listening:
            self.recorder.stop()
        self._reset_speech()
        super().closeEvent(event)


_TERMINATORS = ".!?。！？"


def _split_sentences(text: str) -> tuple[list[str], str]:
    """
    Pull complete sentences out of a growing token buffer; return (sentences, rest).

    A sentence ends at terminator punctuation *followed by whitespace* (or a
    newline). Requiring the trailing space keeps decimals like "3.14" intact and,
    during streaming, defers a sentence whose terminator is the last char so far
    until the next token confirms the boundary.
    """
    sentences: list[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            chunk = text[start:i].strip()
            if chunk:
                sentences.append(chunk)
            start = i + 1
        elif ch in _TERMINATORS:
            j = i
            while j + 1 < n and text[j + 1] in _TERMINATORS:
                j += 1
            nxt = text[j + 1] if j + 1 < n else ""
            if nxt == "":
                break  # terminator at buffer end — wait for the next token
            if nxt.isspace():
                chunk = text[start:j + 1].strip()
                if chunk:
                    sentences.append(chunk)
                start = j + 1
                i = j
        i += 1
    return sentences, text[start:]


_MARKDOWN_NOISE = re.compile(r"[*_`#>]+")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def _clean_for_speech(text: str) -> str:
    """Strip markdown so the synthesizer reads words, not symbols."""
    text = _MD_LINK.sub(r"\1", text)
    text = _MARKDOWN_NOISE.sub("", text)
    return text.strip()


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
