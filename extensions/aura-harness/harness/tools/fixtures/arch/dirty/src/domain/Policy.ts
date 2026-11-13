import { renderRegistration } from '../ui/App';

export function policyShowsUi(): string {
  return renderRegistration({ find: () => null, save: () => {} });
}
