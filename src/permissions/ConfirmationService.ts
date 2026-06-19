import type { AresPermission } from './permissions.js';
import type { RiskLevel } from './permissions.js';

export interface ConfirmationRequest {
  id: string;
  subject: string;
  permissions: AresPermission[];
  risk: RiskLevel;
  reason: string;
  createdAt: string;
}

export interface ConfirmationService {
  request(input: Omit<ConfirmationRequest, 'id' | 'createdAt'>): Promise<ConfirmationRequest>;
  approve(id: string): Promise<boolean>;
  reject(id: string): Promise<boolean>;
  pending(): Promise<ConfirmationRequest[]>;
}

export class InMemoryConfirmationService implements ConfirmationService {
  private readonly requests = new Map<string, ConfirmationRequest>();

  async request(input: Omit<ConfirmationRequest, 'id' | 'createdAt'>): Promise<ConfirmationRequest> {
    const request: ConfirmationRequest = {
      ...input,
      id: `conf_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  async approve(id: string): Promise<boolean> {
    return this.requests.delete(id);
  }

  async reject(id: string): Promise<boolean> {
    return this.requests.delete(id);
  }

  async pending(): Promise<ConfirmationRequest[]> {
    return [...this.requests.values()];
  }
}
