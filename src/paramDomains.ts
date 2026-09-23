/**
 * What a condition/selector parameter means and which values make sense — taken from the
 * engine (conditions.rpy, selector.rpy, time.rpy, consts.rpy, character.rpy) — so the
 * definition cards can offer real choices instead of a bare text box. Curated knowledge
 * is merged with the values the game and its mods actually use for the same parameter
 * (mined by the index), and with the selector keys/values of the event being edited.
 */

export interface DomainOption {
  value: string;
  label?: string;
}

export interface FieldDomain {
  options: DomainOption[];
  /** One-line explanation of the parameter / value format. */
  help?: string;
  /** Only these values are valid (rendered as a dropdown). */
  strict?: boolean;
  /** Suggest the values of the selector named by this sibling parameter (e.g. `key`). */
  valuesOfParam?: string;
}

export interface ClassDomains {
  doc?: string;
  params: Record<string, FieldDomain>;
  /** Extra **kwargs names worth offering (e.g. stat names for StatCondition). */
  keywords?: string[];
}

export interface DomainContext {
  /** Selector keys the edited event provides (with the providing class). */
  selectorKeys: DomainOption[];
  /** Mined usage: values used for `Class.param` across the workspace (most used first). */
  usage: (className: string, param: string) => { value: string; count: number }[];
}

type Source = 'selectorKey' | 'charObj' | 'stat';

interface Known {
  options?: DomainOption[];
  help?: string;
  strict?: boolean;
  source?: Source;
  valuesOfParam?: string;
  /** Don't merge mined usage (e.g. free text). */
  noUsage?: boolean;
}

const NUMBER_PATTERN =
  'Number pattern: 5 (exactly) · 3+ (3 or more) · 5- (5 or less) · 2-4 (range) · 1,3,7+ (list)';

const DAYTIME: DomainOption[] = [
  { value: 'x', label: 'any time' },
  { value: 'd', label: 'day (1–6)' },
  { value: 'c', label: 'class time (2, 4, 5)' },
  { value: 'f', label: 'free time (1, 3, 6)' },
  { value: 'n', label: 'night (7)' },
  { value: '1', label: 'Morning' },
  { value: '2', label: 'Early Noon' },
  { value: '3', label: 'Noon' },
  { value: '4', label: 'Early Afternoon' },
  { value: '5', label: 'Afternoon' },
  { value: '6', label: 'Evening' },
  { value: '7', label: 'Night' },
];

const WEEKDAY: DomainOption[] = [
  { value: 'x', label: 'any day' },
  { value: 'd', label: 'work days (Mon–Fri)' },
  { value: 'w', label: 'weekend (Sat, Sun)' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];

const MONTHS: DomainOption[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
].map((m, i) => ({ value: String(i + 1), label: m }));

const CHARS: DomainOption[] = [
  { value: 'school', label: 'school (students)' },
  { value: 'teacher', label: 'teacher (staff)' },
  { value: 'parent', label: 'parent' },
  { value: 'secretary', label: 'secretary' },
];

export const STATS: DomainOption[] = [
  { value: 'corruption', label: 'CORRUPTION' },
  { value: 'inhibition', label: 'INHIBITION' },
  { value: 'happiness', label: 'HAPPINESS' },
  { value: 'education', label: 'EDUCATION' },
  { value: 'charm', label: 'CHARM' },
  { value: 'reputation', label: 'REPUTATION' },
];

const OPS: DomainOption[] = [
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater or equal' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less or equal' },
  { value: '==', label: 'equal' },
  { value: '!=', label: 'not equal' },
];

const LEVEL_PATTERNS: DomainOption[] = [
  { value: '1', label: 'exactly level 1' },
  { value: '3+', label: 'level 3 or higher' },
  { value: '5+', label: 'level 5 or higher' },
  { value: '1-', label: 'level 1 or lower' },
  { value: '5-', label: 'level 5 or lower' },
  { value: '2-5', label: 'levels 2 to 5' },
  { value: '2,3', label: 'level 2 or 3' },
];

const BOOL: DomainOption[] = [{ value: 'True' }, { value: 'False' }];

const KNOWLEDGE: Record<string, { doc?: string; params: Record<string, Known>; keywords?: string[] }> = {
  TimeCondition: {
    doc: 'Game time window. Every field takes a value, a range (1-5), 3+ / 5-, or a list (1,3,5); x or leaving it out = any.',
    params: {
      daytime: { options: DAYTIME, help: 'c = class time 2,4,5 · f = free time 1,3,6 · d = 1–6 · n = 7 (night) · or 1–7 / ranges' },
      weekday: { options: WEEKDAY, help: 'd = Mon–Fri · w = Sat–Sun · 1 = Monday … 7 = Sunday' },
      day: { help: 'Day of the month (e.g. 1, 15, 1-7, 20+)' },
      week: { help: 'Week of the month (1–4)' },
      month: { options: MONTHS, help: 'Month 1–12 (ranges allowed)' },
      year: { help: 'Year (e.g. 2023, 2024+)' },
      condition: {
        options: [
          { value: '', label: 'equal (default)' },
          { value: '+', label: 'on or after' },
          { value: '-', label: 'on or before' },
        ],
        help: 'How day/month/year compare',
      },
    },
  },
  LevelCondition: {
    doc: "The character's level (default: the school) must match the number pattern.",
    params: {
      value: { options: LEVEL_PATTERNS, help: NUMBER_PATTERN },
      char_obj: { source: 'charObj', help: 'Whose level (default school)' },
    },
  },
  StatCondition: {
    doc: 'Stats of a character (default: school) must match, one keyword per stat: inhibition = "50-".',
    keywords: STATS.map((s) => s.value),
    params: {
      char_obj: { source: 'charObj' },
      ...Object.fromEntries(STATS.map((s) => [s.value, { help: `${s.label} range — ${NUMBER_PATTERN}` } as Known])),
    },
  },
  StatLimitCondition: {
    doc: 'Fulfilled while the stat is below its level limit.',
    params: { stat: { source: 'stat', strict: false }, char_obj: { source: 'charObj' } },
  },
  ProficiencyCondition: {
    doc: 'Headmaster proficiency XP / level must match.',
    params: { xp: { help: NUMBER_PATTERN }, level: { help: NUMBER_PATTERN } },
  },
  BuildingLevelCondition: { doc: 'A building must have the given level.', params: { level: { help: NUMBER_PATTERN } } },
  BuildingCondition: { doc: 'The building must be unlocked.', params: {} },
  MoneyCondition: { doc: 'The school must have at least this much money.', params: {} },
  RandomCondition: {
    doc: 'Random chance: fulfilled when a random number below `limit` is under `threshold`.',
    params: {
      threshold: {
        options: [{ value: '5' }, { value: '10' }, { value: '25' }, { value: '50' }, { value: '75' }],
        help: 'Chance in points of `limit` (with limit 100: percent)',
      },
      limit: { options: [{ value: '100', label: 'default' }] },
    },
  },
  GameDataCondition: { doc: 'A game-data entry (get_game_data(key)) must equal `value`.', params: {} },
  ProgressCondition: {
    doc: 'Progress of an event series. Empty value = any progress made.',
    params: {
      value: { options: [{ value: '', label: 'any progress' }, { value: '1' }, { value: '2+' }, { value: '1-3' }], help: NUMBER_PATTERN },
    },
  },
  ValueCondition: {
    doc: 'A kwargs value (usually from a selector of this event) must equal `value`.',
    params: {
      key: { source: 'selectorKey', help: 'A selector key of this event' },
      value: { valuesOfParam: 'key', help: 'One of the values that selector can produce' },
    },
  },
  CompareCondition: {
    doc: 'A kwargs value must equal `value` (a Selector is rolled first).',
    params: { key: { source: 'selectorKey' }, value: { valuesOfParam: 'key' } },
  },
  NumValueCondition: {
    doc: 'A numeric kwargs value must match a number pattern.',
    params: { key: { source: 'selectorKey' }, value: { help: NUMBER_PATTERN } },
  },
  NumCompareCondition: {
    doc: 'Compares a numeric kwargs value with `value` using `operation`.',
    params: {
      key: { source: 'selectorKey' },
      value: { valuesOfParam: 'key' },
      operation: { options: OPS, strict: true, noUsage: true },
    },
  },
  KeyCompareCondition: {
    doc: 'Compares two kwargs values with each other.',
    params: {
      key_1: { source: 'selectorKey' },
      key_2: { source: 'selectorKey' },
      operation: { options: OPS, strict: true, noUsage: true },
    },
  },
  IntroCondition: { doc: 'Only during (True) / after (False) the intro.', params: { is_intro: { options: BOOL } } },
  EventSeenCondition: { doc: 'Whether the event has been seen before.', params: { seen: { options: BOOL } } },
  BoolCondition: { doc: 'Fixed True / False.', params: { value: { options: BOOL } } },
  ManualCondition: { doc: 'Fixed True / False.', params: { is_fulfilled: { options: BOOL } } },
  ItemCondition: { doc: 'The inventory holds at least `amount` of the item.', params: {} },
  SituationPoolCondition: { doc: 'The situation currently offers this pool.', params: {} },
  SituationStateCondition: { doc: 'The situation is in the given state.', params: {} },
  UnlockableCondition: { doc: 'The unlockable (building, rule, club…) is unlocked.', params: {} },
  UnlockableStateCondition: { doc: 'The unlockable is in the given state.', params: {} },
  RuleCondition: { doc: 'Deprecated — the rule is unlocked (use UnlockableCondition).', params: {} },
  ClubCondition: { doc: 'Deprecated — the club is unlocked (use UnlockableCondition).', params: {} },
  LatchCounterCondition: { doc: 'Fulfilled until the counter reached `max`.', params: {} },
  CounterCondition: { doc: 'Counts how often `condition` held; fulfilled until `max`.', params: {} },
  TimerCondition: { doc: 'Enough time passed since the timer `id` was set.', params: {} },
  // ── Selectors ───────────────────────────────────────────────────────────
  RandomListSelector: {
    doc: 'Picks one value. Entries: value · (0.05, value) weighted · (value, Condition) only when the condition holds · nested selectors.',
    params: {
      key: { help: 'kwargs key the event reads (e.g. topic → <topic> in patterns)', noUsage: true },
      values: { help: 'value · (weight, value) · (value, Condition)', noUsage: true },
      realtime: { options: BOOL, help: 'Re-roll on every read' },
    },
  },
  IterativeListSelector: {
    doc: 'Cycles through the values in order, one per roll.',
    params: { key: { noUsage: true }, values: { noUsage: true } },
  },
  RandomValueSelector: {
    doc: 'A random integer between min_value and max_value (inclusive).',
    params: { key: { noUsage: true }, realtime: { options: BOOL } },
  },
  ConditionSelector: {
    doc: 'true_value when the condition holds, else false_value (either may be a selector).',
    params: { key: { noUsage: true }, realtime: { options: BOOL } },
  },
  ValueSelector: { doc: 'A fixed value.', params: { key: { noUsage: true } } },
  StatSelector: {
    doc: 'The current value of a stat.',
    params: {
      key: { noUsage: true },
      stat: { source: 'stat' },
      char: { source: 'charObj' },
      stat_range: { options: [{ value: '[]', label: 'any' }, { value: '[0, 100]' }], help: '[min, max] range of the stat' },
    },
  },
  LevelSelector: {
    doc: "The character's level (1–10) — fills <school_level>, <teacher_level>, … in patterns.",
    params: {
      key: {
        options: [
          { value: 'school_level', label: 'with char school' },
          { value: 'teacher_level', label: 'with char teacher' },
          { value: 'parent_level', label: 'with char parent' },
          { value: 'secretary_level', label: 'with char secretary' },
        ],
      },
      char: { source: 'charObj' },
    },
  },
  TimeSelector: {
    doc: 'The current game time part.',
    params: {
      key: { noUsage: true },
      time_type: {
        options: [
          { value: 'daytime', label: '1–7' },
          { value: 'weekday', label: '1–7 (Mon–Sun)' },
          { value: 'day', label: 'day of month' },
          { value: 'month', label: '1–12' },
          { value: 'year' },
        ],
        strict: false,
      },
    },
  },
  CharacterSelector: { doc: 'A character object.', params: { key: { noUsage: true }, char: { source: 'charObj' } } },
  KwargsValueSelector: { doc: 'Copies another kwargs value.', params: { key: { noUsage: true }, kwargs_key: { source: 'selectorKey' } } },
  DictSelector: { doc: 'Looks up kwargs[index] in the dict.', params: { key: { noUsage: true }, index: { source: 'selectorKey' } } },
  GameDataSelector: { doc: 'A game-data entry (alt when missing).', params: { key: { noUsage: true } } },
  ProgressSelector: { doc: 'The progress of an event series (-1 when none).', params: { key: { noUsage: true } } },
  BuildingUnlockedSelector: { doc: 'True when the unlockable is unlocked.', params: { key: { noUsage: true } } },
  BuildingLevelSelector: { doc: 'The level of a building.', params: { key: { noUsage: true } } },
  NumClampSelector: { doc: 'A number clamped between min_value and max_value.', params: { key: { noUsage: true } } },
  Pattern: {
    doc: 'Image pattern: key + path with <placeholders>; extra arguments name the alternative keys that may fall back to $ files.',
    params: {
      name: { options: [{ value: 'main' }], help: "Pattern key (convert_pattern('main'))" },
      pattern: { help: 'e.g. images/events/x/x <school_level> <step>.webp', noUsage: true },
      alternative_keys: {
        source: 'selectorKey',
        options: [{ value: 'school_level' }, { value: 'teacher_level' }, { value: 'parent_level' }, { value: 'secretary_level' }],
        help: 'Placeholders that may fall back to a $ file when no exact image exists',
      },
    },
  },
};

export function classDoc(className: string): string | undefined {
  return KNOWLEDGE[className]?.doc;
}

/** Everything the UI needs for one class (merged curated + mined + event context). */
export function classDomains(className: string, params: string[], ctx: DomainContext): ClassDomains {
  const known = KNOWLEDGE[className];
  const out: ClassDomains = { doc: known?.doc, params: {}, keywords: known?.keywords };
  const names = new Set([...params, ...Object.keys(known?.params ?? {})]);
  for (const name of names) {
    const d = fieldDomain(className, name, ctx);
    if (d) {
      out.params[name] = d;
    }
  }
  return out;
}

export function fieldDomain(className: string, param: string, ctx: DomainContext): FieldDomain | undefined {
  const k = KNOWLEDGE[className]?.params[param];
  const options: DomainOption[] = [];
  const add = (o: DomainOption) => {
    if (!options.some((x) => x.value === o.value)) {
      options.push(o);
    }
  };
  (k?.options ?? []).forEach(add);
  if (k?.source === 'selectorKey') {
    ctx.selectorKeys.forEach(add);
  } else if (k?.source === 'charObj') {
    CHARS.forEach(add);
  } else if (k?.source === 'stat') {
    STATS.forEach(add);
  }
  if (!k?.noUsage && !k?.strict) {
    for (const u of ctx.usage(className, param).slice(0, 25)) {
      add({ value: u.value, label: `used ${u.count}×` });
    }
  }
  if (!options.length && !k?.help && !k?.valuesOfParam) {
    return undefined;
  }
  return { options, help: k?.help, strict: k?.strict, valuesOfParam: k?.valuesOfParam };
}
