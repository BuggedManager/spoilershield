import dictionaryJson from './generated/dictionary.json';
import type { CompiledDictionary } from './dictionary';
import { Detector, type DetectorOptions } from './engine';
import type { Mode, Settings } from '../storage/settings';

export const DICTIONARY = dictionaryJson as unknown as CompiledDictionary;

export function optionsFromSettings(s: Settings, mode: Mode = s.mode): DetectorOptions {
  return {
    mode,
    sensitivity: s.sensitivity,
    blockGameContent: s.blockGameContent,
    blockStorySpoilers: s.blockStorySpoilers,
    languages: s.languages,
    extended: s.extendedDetection,
    builtinEnabled: s.builtinProfileEnabled,
    customKeywords: s.customKeywords,
    profiles: s.profiles,
  };
}

export function createDetector(s: Settings, mode?: Mode): Detector {
  return new Detector(DICTIONARY, optionsFromSettings(s, mode));
}

export { Detector };
export type { Detection } from './engine';
