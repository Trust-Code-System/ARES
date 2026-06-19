import { redactSensitiveData } from '../security/redactor.js';

export class ToolResultNormalizer {
  normalize(result: unknown): unknown {
    return redactSensitiveData(result);
  }
}
