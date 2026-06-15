/** Confirmation-gated cross-platform application and URL launching. */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from '../../types.js';
import { defineTool } from '../define.js';

interface ApplicationCommand {
  command: string;
  args: string[];
}

export interface SystemLauncher {
  readonly applications: string[];
  openApplication(name: string): Promise<void>;
  openUrl(url: string): Promise<void>;
}

export function createSystemActionTools(launcher: SystemLauncher = new DesktopLauncher()): Tool[] {
  const openApplication = defineTool({
    name: 'open_application',
    description:
      `Open an approved desktop application. Available application aliases: ` +
      `${launcher.applications.join(', ')}. This always requires confirmation.`,
    kind: 'state_mutating',
    schema: z.object({
      // The approved list is fixed per platform; emit it as an enum so the model
      // can only pick a valid alias (the handler re-checks defensively).
      application: z
        .enum(launcher.applications as [string, ...string[]])
        .describe('Approved application alias.'),
    }),
    async execute(input) {
      const application = String(input.application ?? '').toLowerCase();
      if (!launcher.applications.includes(application)) {
        return {
          ok: false,
          content: `Application "${application}" is not approved. Available: ${launcher.applications.join(', ')}.`,
        };
      }
      await launcher.openApplication(application);
      return { ok: true, content: `Opened ${application}.`, data: { application } };
    },
  });

  const openUrl = defineTool({
    name: 'open_url',
    description:
      'Open an HTTP or HTTPS website in the default browser. This affects the desktop and requires confirmation.',
    kind: 'state_mutating',
    schema: z.object({
      url: z.string().describe('Absolute http(s) URL to open.'),
    }),
    async execute(input) {
      let url: URL;
      try {
        url = new URL(String(input.url ?? ''));
      } catch {
        return { ok: false, content: 'URL must be an absolute HTTP or HTTPS URL.' };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, content: 'Only HTTP and HTTPS URLs may be opened.' };
      }
      await launcher.openUrl(url.toString());
      return { ok: true, content: `Opened ${url.toString()}.`, data: { url: url.toString() } };
    },
  });

  return [openApplication, openUrl];
}

export class DesktopLauncher implements SystemLauncher {
  private readonly commands: Record<string, ApplicationCommand>;
  readonly applications: string[];

  constructor(platform = process.platform) {
    this.commands = commandsFor(platform);
    this.applications = Object.keys(this.commands).sort();
  }

  openApplication(name: string): Promise<void> {
    const command = this.commands[name];
    if (!command) return Promise.reject(new Error(`Unknown application alias: ${name}`));
    return launch(command.command, command.args);
  }

  openUrl(url: string): Promise<void> {
    if (process.platform === 'win32') {
      return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
    }
    if (process.platform === 'darwin') return launch('open', [url]);
    return launch('xdg-open', [url]);
  }
}

function commandsFor(platform: NodeJS.Platform): Record<string, ApplicationCommand> {
  if (platform === 'win32') {
    return {
      calculator: { command: 'calc.exe', args: [] },
      explorer: { command: 'explorer.exe', args: [] },
      notepad: { command: 'notepad.exe', args: [] },
      terminal: { command: 'wt.exe', args: [] },
    };
  }
  if (platform === 'darwin') {
    return {
      calculator: { command: 'open', args: ['-a', 'Calculator'] },
      files: { command: 'open', args: ['.'] },
      terminal: { command: 'open', args: ['-a', 'Terminal'] },
      textedit: { command: 'open', args: ['-a', 'TextEdit'] },
    };
  }
  return {
    calculator: { command: 'gnome-calculator', args: [] },
    files: { command: 'xdg-open', args: ['.'] },
    terminal: { command: 'x-terminal-emulator', args: [] },
    texteditor: { command: 'gedit', args: [] },
  };
}

function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
