export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const stopAtFirstPositional = config.stopAtFirstPositional ?? false;
  const options = {};
  const positionals = [];
  let passthrough = false;
  // True only while passthrough was entered via stopAtFirstPositional, so a
  // token after an explicit bare "--" (a deliberate escape) is never reported.
  let passthroughFromFirstPositional = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      if (stopAtFirstPositional) {
        passthrough = true;
        passthroughFromFirstPositional = true;
      }
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      throw new Error(
        `Unknown option: --${rawKey}. Pass literal text after a bare "--" if it is not a flag.`
      );
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    throw new Error(
      `Unknown option: -${shortKey}. Pass literal text after a bare "--" if it is not a flag.`
    );
  }

  // A forgotten flag lands at the tail of the prose, not buried in the
  // middle of it (prompts routinely discuss flag names in passing, e.g.
  // "explain what --write does" or "fix the --wait bug" -- those are not
  // warnings). Only two shapes count as "forgotten flag at the tail":
  //   - the last positional itself looks like a declared option, or
  //   - the second-to-last positional looks like a declared *value* option,
  //     with the last positional as its would-be value (e.g. "-C /tmp").
  const literalOptionLikePositionals = [];
  if (passthroughFromFirstPositional && positionals.length > 0) {
    const lastIndex = positionals.length - 1;
    const last = positionals[lastIndex];
    if (looksLikeDeclaredOption(last, valueOptions, booleanOptions, aliasMap)) {
      literalOptionLikePositionals.push(last);
    } else if (lastIndex >= 1) {
      const secondToLast = positionals[lastIndex - 1];
      if (looksLikeDeclaredValueOption(secondToLast, valueOptions, aliasMap)) {
        literalOptionLikePositionals.push(secondToLast);
      }
    }
  }

  return { options, positionals, literalOptionLikePositionals };
}

// Mirrors the key-normalization the parser applies to real flag tokens
// (strip leading dashes, split "=", resolve aliases) so a literal positional
// can be checked against the same valueOptions/booleanOptions sets.
function normalizeLiteralOptionKey(token, aliasMap) {
  const stripped = token.startsWith("--") ? token.slice(2) : token.slice(1);
  const [rawKey] = stripped.split("=", 2);
  return aliasMap[rawKey] ?? rawKey;
}

function looksLikeDeclaredOption(token, valueOptions, booleanOptions, aliasMap) {
  if (token === "-" || !token.startsWith("-")) {
    return false;
  }
  const key = normalizeLiteralOptionKey(token, aliasMap);
  return valueOptions.has(key) || booleanOptions.has(key);
}

function looksLikeDeclaredValueOption(token, valueOptions, aliasMap) {
  if (token === "-" || !token.startsWith("-")) {
    return false;
  }
  const key = normalizeLiteralOptionKey(token, aliasMap);
  return valueOptions.has(key);
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
