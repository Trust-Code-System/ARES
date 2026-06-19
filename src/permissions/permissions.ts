export const ARES_PERMISSIONS = [
  'read_files',
  'write_files',
  'create_files',
  'delete_files',
  'run_shell',
  'access_network',
  'access_browser',
  'submit_forms',
  'send_email',
  'read_email',
  'access_calendar',
  'create_calendar_event',
  'modify_calendar_event',
  'access_contacts',
  'access_database',
  'write_database',
  'access_memory',
  'write_memory',
  'access_secrets',
  'modify_production',
  'make_payment',
  'trade_financial_assets',
  'publish_content',
  'install_dependencies',
  'modify_git',
  'deploy_app',
] as const;

export type AresPermission = (typeof ARES_PERMISSIONS)[number];
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const PERMISSION_RISK: Record<AresPermission, RiskLevel> = {
  read_files: 'low',
  access_memory: 'low',
  access_contacts: 'medium',
  access_calendar: 'medium',
  read_email: 'medium',
  access_browser: 'medium',
  access_database: 'medium',
  access_network: 'medium',
  create_files: 'medium',
  write_files: 'high',
  write_memory: 'high',
  write_database: 'high',
  run_shell: 'high',
  install_dependencies: 'high',
  modify_git: 'high',
  submit_forms: 'high',
  send_email: 'high',
  create_calendar_event: 'high',
  modify_calendar_event: 'high',
  publish_content: 'high',
  delete_files: 'critical',
  access_secrets: 'critical',
  modify_production: 'critical',
  make_payment: 'critical',
  trade_financial_assets: 'critical',
  deploy_app: 'critical',
};

export const FORBIDDEN_PERMISSIONS = new Set<AresPermission>(['access_secrets']);

export const STATE_CHANGING_PERMISSIONS = new Set<AresPermission>([
  'write_files',
  'create_files',
  'delete_files',
  'submit_forms',
  'send_email',
  'create_calendar_event',
  'modify_calendar_event',
  'write_database',
  'write_memory',
  'modify_production',
  'make_payment',
  'trade_financial_assets',
  'publish_content',
  'install_dependencies',
  'modify_git',
  'deploy_app',
]);

export function isAresPermission(value: string): value is AresPermission {
  return (ARES_PERMISSIONS as readonly string[]).includes(value);
}

export function highestRisk(permissions: readonly AresPermission[]): RiskLevel {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return permissions.reduce<RiskLevel>((worst, permission) => (
    rank[PERMISSION_RISK[permission]] > rank[worst] ? PERMISSION_RISK[permission] : worst
  ), 'low');
}
