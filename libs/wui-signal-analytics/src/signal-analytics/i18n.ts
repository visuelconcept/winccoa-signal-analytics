// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable sonarjs/no-duplicate-string -- a translation catalog repeats short labels ("Window", "Engine") across dialog and table by design */

/**
 * Internationalisation for the Signal Analytics page.
 *
 * All user-visible strings are {@link MultiLangString} maps resolved against the
 * active WebUI language via `lit-translate` (shared singleton — same instance as
 * the app shell, so the page follows the user's language). Use {@link localizeDir}
 * inside templates (reactive, re-renders on language change) and {@link localize}
 * for plain-string contexts (current language at call time).
 *
 * Locale keys use the base `.utf8` form (`en_US.utf8` / `fr.utf8` / `de.utf8`) so
 * any country variant (fr_FR, de_AT, de_CH…) still resolves — the resolver falls
 * back to the language sub-tag.
 */
import type { MultiLangString } from '@wincc-oa/wui-models/interfaces/multi-lang-string.js';
import { localize } from '@wincc-oa/wui-i18n-shared/localize-multilang.js';

export {
  localize,
  localizeDir
} from '@wincc-oa/wui-i18n-shared/localize-multilang.js';

/** Build a tri-lingual string (English / French / German). */
export function ml(en: string, fr: string, de: string): MultiLangString {
  return { 'en_US.utf8': en, 'fr.utf8': fr, 'de.utf8': de };
}

export const MSG = {
  page: {
    subtitle: ml(
      'Anomalies and recurring shapes, found by a WinCC OA Python manager',
      'Anomalies et formes récurrentes, détectées par un manager Python WinCC OA',
      'Anomalien und wiederkehrende Muster, erkannt von einem WinCC OA Python-Manager'
    ),
    newSignal: ml('New signal', 'Nouveau signal', 'Neues Signal'),
    refresh: ml('Refresh', 'Actualiser', 'Aktualisieren'),
    empty: ml(
      'No signal configured yet. Add one to have its history analysed.',
      'Aucun signal configuré. Ajoutez-en un pour faire analyser son historique.',
      'Noch kein Signal konfiguriert. Fügen Sie eines hinzu, um seine Historie zu analysieren.'
    ),
    offline: ml(
      'Demonstration mode: no backend reachable, so nothing is saved and the findings below are fabricated.',
      'Mode démonstration : aucun backend joignable, rien n’est enregistré et les résultats ci-dessous sont fictifs.',
      'Demonstrationsmodus: kein Backend erreichbar, nichts wird gespeichert und die Ergebnisse unten sind erfunden.'
    ),
    roleForbidden: ml(
      'Your groups do not hold the “view” role of this page.',
      'Vos groupes ne possèdent pas le rôle « consulter » de cette page.',
      'Ihre Gruppen besitzen die Rolle „Ansehen“ dieser Seite nicht.'
    ),
    managerSilent: ml(
      'The Python manager has never answered on this signal. Check that signal_analytics_manager.py is started in the console.',
      'Le manager Python n’a jamais répondu sur ce signal. Vérifiez que signal_analytics_manager.py est démarré dans la console.',
      'Der Python-Manager hat zu diesem Signal noch nie geantwortet. Prüfen Sie, ob signal_analytics_manager.py in der Konsole gestartet ist.'
    )
  },

  list: {
    signals: ml('Signals', 'Signaux', 'Signale'),
    anomalies: ml('Anomalies', 'Anomalies', 'Anomalien'),
    recurrences: ml('Recurrences', 'Récurrences', 'Wiederholungen'),
    watching: ml('Live', 'Temps réel', 'Echtzeit'),
    disabled: ml('Disabled', 'Désactivé', 'Deaktiviert')
  },

  actions: {
    analyse: ml('Analyse', 'Analyser', 'Analysieren'),
    edit: ml('Edit', 'Modifier', 'Bearbeiten'),
    delete: ml('Delete', 'Supprimer', 'Löschen'),
    close: ml('Close', 'Fermer', 'Schließen'),
    cancel: ml('Cancel', 'Annuler', 'Abbrechen'),
    save: ml('Save', 'Enregistrer', 'Speichern'),
    create: ml('Create', 'Créer', 'Anlegen')
  },

  state: {
    idle: ml('Never analysed', 'Jamais analysé', 'Nie analysiert'),
    queued: ml('Queued', 'En file', 'In Warteschlange'),
    running: ml('Analysing…', 'Analyse en cours…', 'Analyse läuft…'),
    done: ml('Analysed', 'Analysé', 'Analysiert'),
    error: ml('Failed', 'Échec', 'Fehlgeschlagen')
  },

  engine: {
    label: ml('Engine', 'Moteur', 'Verfahren'),
    numpy: ml(
      'Matrix profile (built in)',
      'Matrix profile (intégré)',
      'Matrix Profile (integriert)'
    ),
    stumpy: ml(
      'Matrix profile — STUMPY',
      'Matrix profile — STUMPY',
      'Matrix Profile — STUMPY'
    ),
    chronos: ml(
      'Chronos (forecasting)',
      'Chronos (prévision)',
      'Chronos (Prognose)'
    ),
    numpyHint: ml(
      'Finds shapes that occur nowhere else in the period. No installation needed.',
      'Détecte les formes qui n’apparaissent nulle part ailleurs sur la période. Aucune installation requise.',
      'Findet Muster, die sonst nirgends in der Periode vorkommen. Keine Installation nötig.'
    ),
    stumpyHint: ml(
      'Same result as the built-in engine, much faster on long periods. Needs “pip install stumpy” on the server.',
      'Même résultat que le moteur intégré, bien plus rapide sur les longues périodes. Nécessite « pip install stumpy » sur le serveur.',
      'Gleiches Ergebnis wie das integrierte Verfahren, deutlich schneller bei langen Perioden. Benötigt „pip install stumpy“ am Server.'
    ),
    chronosHint: ml(
      'Flags what a pretrained model did not see coming, rather than what never recurred. Needs torch — a multi-gigabyte install.',
      'Signale ce qu’un modèle pré-entraîné n’a pas su prévoir, plutôt que ce qui ne se répète pas. Nécessite torch — plusieurs gigaoctets.',
      'Meldet, was ein vortrainiertes Modell nicht vorhergesehen hat, statt was sich nie wiederholt. Benötigt torch — mehrere Gigabyte.'
    ),
    unavailable: ml(
      'not installed on the server',
      'non installé sur le serveur',
      'am Server nicht installiert'
    )
  },

  form: {
    createTitle: ml(
      'New analysed signal',
      'Nouveau signal analysé',
      'Neues analysiertes Signal'
    ),
    editTitle: ml('Edit signal', 'Modifier le signal', 'Signal bearbeiten'),
    label: ml('Name', 'Nom', 'Name'),
    dpe: ml('Datapoint element', 'Élément de datapoint', 'Datenpunktelement'),
    dpeHint: ml(
      'The archived elements to analyse. Several elements = ONE joint analysis: anomalies that only exist in the correlation between signals become detectable.',
      'Les éléments archivés à analyser. Plusieurs éléments = UNE analyse jointe : les anomalies qui n’existent que dans la corrélation entre signaux deviennent détectables.',
      'Die archivierten Elemente. Mehrere Elemente = EINE gemeinsame Analyse: Anomalien, die nur in der Korrelation zwischen Signalen existieren, werden erkennbar.'
    ),
    addElement: ml(
      'Add an element',
      'Ajouter un élément',
      'Element hinzufügen'
    ),
    removeElement: ml(
      'Remove this element',
      'Retirer cet élément',
      'Dieses Element entfernen'
    ),
    enabled: ml('Enabled', 'Activé', 'Aktiviert'),
    window: ml(
      'Window (samples)',
      'Fenêtre (échantillons)',
      'Fenster (Abtastwerte)'
    ),
    windowHint: ml(
      'Length of the shape to look for. Too short matches noise, too long matches nothing.',
      'Longueur de la forme recherchée. Trop courte, elle capte le bruit ; trop longue, elle ne capte rien.',
      'Länge des gesuchten Musters. Zu kurz erfasst Rauschen, zu lang gar nichts.'
    ),
    historyHours: ml(
      'History (hours)',
      'Historique (heures)',
      'Historie (Stunden)'
    ),
    maxPoints: ml(
      'Max points analysed',
      'Points analysés (max)',
      'Analysierte Punkte (max.)'
    ),
    maxPointsHint: ml(
      'The period is resampled to this many points. Higher is finer and slower — the cost grows with the square.',
      'La période est rééchantillonnée à ce nombre de points. Plus haut = plus fin et plus lent — le coût croît au carré.',
      'Die Periode wird auf so viele Punkte resampled. Höher = feiner und langsamer — der Aufwand wächst quadratisch.'
    ),
    maxAnomalies: ml(
      'Anomalies reported (max)',
      'Anomalies remontées (max)',
      'Gemeldete Anomalien (max.)'
    ),
    sensitivity: ml('Sensitivity', 'Sensibilité', 'Empfindlichkeit'),
    sensitivityHint: ml(
      'Threshold in robust sigmas. Lower reports more, higher reports only the clearest.',
      'Seuil en sigmas robustes. Plus bas remonte davantage, plus haut ne garde que le plus net.',
      'Schwelle in robusten Sigmas. Niedriger meldet mehr, höher nur das Deutlichste.'
    ),
    maxRecurrences: ml(
      'Recurrences reported (max)',
      'Récurrences remontées (max)',
      'Gemeldete Wiederholungen (max.)'
    ),
    radius: ml(
      'Recurrence tolerance',
      'Tolérance de récurrence',
      'Wiederholungstoleranz'
    ),
    radiusHint: ml(
      'How different an occurrence may be and still count as the same shape.',
      'Écart maximal toléré pour qu’une occurrence compte encore comme la même forme.',
      'Wie stark eine Wiederholung abweichen darf und noch als dasselbe Muster zählt.'
    ),
    realtime: ml(
      'Watch live values',
      'Surveiller en temps réel',
      'Echtzeitwerte überwachen'
    ),
    realtimeHint: ml(
      'After an analysis, every new value is scored against the analysed history.',
      'Après une analyse, chaque nouvelle valeur est comparée à l’historique analysé.',
      'Nach einer Analyse wird jeder neue Wert mit der analysierten Historie verglichen.'
    ),
    throttle: ml(
      'Live refresh (ms)',
      'Rafraîchissement live (ms)',
      'Live-Aktualisierung (ms)'
    ),
    bufferPoints: ml(
      'Live buffer (points)',
      'Tampon live (points)',
      'Live-Puffer (Punkte)'
    ),
    chronosSection: ml('Chronos model', 'Modèle Chronos', 'Chronos-Modell'),
    chronosModel: ml('Model', 'Modèle', 'Modell'),
    chronosContext: ml(
      'Context (samples)',
      'Contexte (échantillons)',
      'Kontext (Abtastwerte)'
    ),
    chronosHorizon: ml(
      'Horizon (samples)',
      'Horizon (échantillons)',
      'Horizont (Abtastwerte)'
    ),
    advanced: ml(
      'Detection parameters',
      'Paramètres de détection',
      'Erkennungsparameter'
    ),
    labelRequired: ml(
      'A name is required.',
      'Un nom est requis.',
      'Ein Name ist erforderlich.'
    ),
    dpeRequired: ml(
      'At least one datapoint element is required.',
      'Au moins un élément de datapoint est requis.',
      'Mindestens ein Datenpunktelement ist erforderlich.'
    )
  },

  filters: {
    title: ml('Display', 'Affichage', 'Anzeige'),
    anomalies: ml('Anomalies', 'Anomalies', 'Anomalien'),
    recurrences: ml('Recurrences', 'Récurrences', 'Wiederholungen'),
    band: ml('Score band', 'Bande de score', 'Score-Band'),
    minSeverity: ml('Min severity', 'Sévérité min', 'Mindestschwere'),
    all: ml('All', 'Toutes', 'Alle'),
    filtered: ml(
      'hidden by the severity filter',
      'masquées par le filtre de sévérité',
      'durch den Schwere-Filter ausgeblendet'
    )
  },

  summary: {
    title: ml('Last analysis', 'Dernière analyse', 'Letzte Analyse'),
    period: ml('Analysed period', 'Période analysée', 'Analysierte Periode'),
    engine: ml('Engine', 'Moteur', 'Verfahren'),
    window: ml('Window', 'Fenêtre', 'Fenster'),
    points: ml('Points', 'Points', 'Punkte'),
    threshold: ml('Threshold', 'Seuil', 'Schwelle'),
    elements: ml('Elements', 'Éléments', 'Elemente'),
    computed: ml('Computed', 'Calculée le', 'Berechnet am'),
    took: ml('in', 'en', 'in'),
    staleParams: ml(
      'The configuration changed after this analysis — run it again for the new parameters to apply.',
      'La configuration a changé après cette analyse — relancez-la pour que les nouveaux paramètres s’appliquent.',
      'Die Konfiguration wurde nach dieser Analyse geändert — erneut ausführen, damit die neuen Parameter gelten.'
    )
  },

  detail: {
    history: ml('Analysed period', 'Période analysée', 'Analysierte Periode'),
    liveTitle: ml(
      'Live watch',
      'Surveillance temps réel',
      'Echtzeitüberwachung'
    ),
    notAnalysed: ml(
      'Run an analysis to see anomalies and recurrences here.',
      'Lancez une analyse pour voir ici les anomalies et les récurrences.',
      'Starten Sie eine Analyse, um hier Anomalien und Wiederholungen zu sehen.'
    ),
    syntheticCurve: ml(
      'Simulated curve — this element has no archived history to read.',
      'Courbe simulée — cet élément n’a pas d’historique archivé à lire.',
      'Simulierte Kurve — für dieses Element gibt es keine archivierte Historie.'
    ),
    noAnomaly: ml(
      'No anomaly above the threshold over this period.',
      'Aucune anomalie au-dessus du seuil sur cette période.',
      'Keine Anomalie über der Schwelle in dieser Periode.'
    ),
    noRecurrence: ml(
      'No shape recurred often enough to be reported.',
      'Aucune forme ne se répète assez pour être remontée.',
      'Kein Muster wiederholt sich häufig genug für eine Meldung.'
    ),
    notArmed: ml(
      'Live scoring starts after the first analysis.',
      'La surveillance temps réel démarre après la première analyse.',
      'Die Echtzeitbewertung beginnt nach der ersten Analyse.'
    ),
    realtimeOff: ml(
      'Live watching is switched off for this signal.',
      'La surveillance temps réel est désactivée pour ce signal.',
      'Die Echtzeitüberwachung ist für dieses Signal ausgeschaltet.'
    ),
    score: ml('Score', 'Score', 'Score'),
    threshold: ml('Threshold', 'Seuil', 'Schwelle'),
    severity: ml('Severity', 'Sévérité', 'Schwere'),
    when: ml('When', 'Quand', 'Wann'),
    duration: ml('Duration', 'Durée', 'Dauer'),
    occurrences: ml('Occurrences', 'Occurrences', 'Vorkommen'),
    period: ml('Cycle', 'Cycle', 'Zyklus'),
    match: ml('Match', 'Similarité', 'Übereinstimmung'),
    drivenBy: ml('driven by', 'porté par', 'getragen von'),
    sampleStep: ml('Sample step', 'Pas d’échantillonnage', 'Abtastschritt'),
    analysedOn: ml('Analysed', 'Analysé le', 'Analysiert am'),
    took: ml('Took', 'Durée', 'Dauer'),
    liveEvents: ml(
      'Live excursions',
      'Excursions temps réel',
      'Echtzeit-Ausreißer'
    ),
    noLiveEvent: ml(
      'No live excursion since the last analysis.',
      'Aucune excursion temps réel depuis la dernière analyse.',
      'Keine Echtzeit-Ausreißer seit der letzten Analyse.'
    )
  },

  confirm: {
    deleteTitle: ml(
      'Delete this signal?',
      'Supprimer ce signal ?',
      'Dieses Signal löschen?'
    )
  }
} as const;

/** "Fell back to numpy: stumpy is not installed" — the manager's own reason. */
export function fallbackMsg(engine: string, reason: string): MultiLangString {
  return ml(
    `Ran on “${engine}” instead: ${reason}`,
    `Exécuté sur « ${engine} » à la place : ${reason}`,
    `Stattdessen mit „${engine}“ ausgeführt: ${reason}`
  );
}

/** "3 anomalies · 2 recurrences" as one localised sentence. */
export function findingsMsg(
  anomalies: number,
  recurrences: number
): MultiLangString {
  return ml(
    `${anomalies} anomalies · ${recurrences} recurrences`,
    `${anomalies} anomalies · ${recurrences} récurrences`,
    `${anomalies} Anomalien · ${recurrences} Wiederholungen`
  );
}

/** "64 samples ≈ 3 min 12 s" — a window is only meaningful as a duration. */
export function windowMsg(
  samples: number,
  humanDuration: string
): MultiLangString {
  return ml(
    `${samples} samples ≈ ${humanDuration}`,
    `${samples} échantillons ≈ ${humanDuration}`,
    `${samples} Abtastwerte ≈ ${humanDuration}`
  );
}

export function confirmDeleteMsg(label: string): MultiLangString {
  return ml(
    `“${label}” and its datapoint will be deleted. Past findings are lost.`,
    `« ${label} » et son datapoint seront supprimés. Les résultats passés sont perdus.`,
    `„${label}“ und sein Datenpunkt werden gelöscht. Bisherige Ergebnisse gehen verloren.`
  );
}

/** Localised label of an engine id, for a select or a badge. */
export function engineLabel(engine: string): MultiLangString {
  if (engine === 'stumpy') return MSG.engine.stumpy;
  if (engine === 'chronos') return MSG.engine.chronos;
  return MSG.engine.numpy;
}

/** Localised label of a run state. */
export function stateLabel(state: string): MultiLangString {
  if (state === 'queued') return MSG.state.queued;
  if (state === 'running') return MSG.state.running;
  if (state === 'done') return MSG.state.done;
  if (state === 'error') return MSG.state.error;
  return MSG.state.idle;
}

/** Current language's text of a {@link MultiLangString} — for aria/title strings. */
export function text(value: MultiLangString): string {
  return localize(value);
}
