import { ConfigError } from '../auth.js';

// The calendar's iCal subscription (the secret URL for a personal calendar). It is off in the Discord login
// (the mail folder, outside the committee's network) and on in the demo, where every name is synthetic.
// SMM_CALENDAR_ICAL=on turns it on, =off turns it off whatever the mode, and nothing else is accepted.

export interface CalendarConfig {
  /** Whether the subscription URL answers (and the screen offers it). */
  ical: boolean;
}

export function parseCalendarConfig(env: NodeJS.ProcessEnv, mode: string): CalendarConfig {
  const raw = env.SMM_CALENDAR_ICAL;
  if (raw === undefined || raw === '') return { ical: mode === 'demo' };
  if (raw === 'on') return { ical: true };
  if (raw === 'off') return { ical: false };
  throw new ConfigError('SMM_CALENDAR_ICAL は on か off で指定してください。');
}
