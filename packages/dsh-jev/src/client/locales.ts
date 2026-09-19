/**
 * Copy for the Jev plugin's configuration page in the DSH web client.
 *
 * @module dsh-jev/client/locales
 */

/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'Jev decision layer',
  summary: 'Fast structured decisions along the DSH agent loop.',
  intro: 'DeepSeek Harness plans, calls tools, and runs them. Jev answers small semantic questions in between, and this plugin maps those answers onto DSH behavior. It can only narrow or gate — never widen a permission.',
  statusLoading: 'Loading current configuration…',
  statusUnavailable: 'Settings are not available in this deployment; the plugin runs from its cordis.yml entry.',
  provider: 'Provider',
  providerMock: 'mock — deterministic, offline',
  providerLive: 'live — TypeSafe API (bounded task state is transmitted)',
  mode: 'Mode',
  modeOff: 'Off',
  modeShadow: 'Shadow',
  modeEnforce: 'Enforce',
  modeHintOff: 'No Jev requests at all.',
  modeHintShadow: 'Jev answers and everything is logged; agent behavior is unchanged.',
  modeHintEnforce: 'Jev decisions are applied: selection, gating, routing, loop guard.',
  features: 'Features',
  featureSelection: 'Dynamic tool selection (keep only relevant tools visible)',
  featureAssessment: 'Call assessment (ask / hold / deny before a tool runs)',
  featureLoopDetection: 'Loop guard (stop identical repeated calls)',
  featureSkills: 'Skill routing (suggest one relevant skill)',
  featureModelRouting: 'Model routing (use a configured route when verified available)',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Could not save: ',
  writable: 'These values are stored in the host settings document and apply immediately.',
  readOnly: 'This client cannot write settings here.',
  docs: 'How it works',
} as const

/** The `settings.jev` dictionary key union. */
export type JevKey = keyof typeof en

/** German dictionary, checked complete against the English key set. */
export const de = {
  title: 'Jev-Entscheidungsschicht',
  summary: 'Schnelle strukturierte Entscheidungen im DSH-Agentenablauf.',
  intro: 'DeepSeek Harness plant, ruft Tools auf und führt sie aus. Jev beantwortet dazwischen kleine semantische Fragen, und dieses Plugin übersetzt die Antworten in DSH-Verhalten. Es kann Berechtigungen nur einschränken oder sperren — niemals erweitern.',
  statusLoading: 'Aktuelle Konfiguration wird geladen…',
  statusUnavailable: 'Einstellungen sind in diesem Deployment nicht verfügbar; das Plugin läuft mit seinem cordis.yml-Eintrag.',
  provider: 'Provider',
  providerMock: 'mock — deterministisch, offline',
  providerLive: 'live — TypeSafe-API (begrenzter Aufgaben-Zustand wird übertragen)',
  mode: 'Modus',
  modeOff: 'Aus',
  modeShadow: 'Shadow',
  modeEnforce: 'Enforce',
  modeHintOff: 'Keine Jev-Anfragen.',
  modeHintShadow: 'Jev antwortet und alles wird protokolliert; das Agentenverhalten bleibt unverändert.',
  modeHintEnforce: 'Jev-Entscheidungen werden angewendet: Auswahl, Prüfung, Routing, Loop-Guard.',
  features: 'Funktionen',
  featureSelection: 'Dynamische Tool-Auswahl (nur relevante Tools sichtbar)',
  featureAssessment: 'Aufruf-Prüfung (ask / hold / deny vor der Ausführung)',
  featureLoopDetection: 'Loop-Guard (identische Wiederholungen stoppen)',
  featureSkills: 'Skill-Routing (einen relevanten Skill vorschlagen)',
  featureModelRouting: 'Modell-Routing (konfigurierte Route, sofern verfügbar)',
  save: 'Speichern',
  saving: 'Speichern…',
  saved: 'Gespeichert',
  failed: 'Speichern fehlgeschlagen: ',
  writable: 'Diese Werte liegen im Host-Settings-Dokument und gelten sofort.',
  readOnly: 'Dieser Client darf hier keine Einstellungen schreiben.',
  docs: 'So funktioniert es',
} satisfies Record<JevKey, string>
