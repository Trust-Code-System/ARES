import { redactSensitiveData, redactSensitiveText } from '../security/redactor.js';

export class MemoryRedactor {
  redactText(text: string): string {
    return redactSensitiveText(text);
  }

  redact<T>(value: T): T {
    return redactSensitiveData(value);
  }
}
