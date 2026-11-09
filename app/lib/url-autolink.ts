// Adapted from micromark-extension-gfm-autolink-literal 2.1.0.
// URL boundaries are lexical, so following Markdown keeps its original tokens.
/*
(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
import type { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";

type Extension = ReturnType<typeof gfmAutolinkLiteral>;
type Construct = Exclude<NonNullable<NonNullable<Extension["text"]>[number]>, unknown[]>;
type Tokenizer = Construct["tokenize"];
type TokenizeContext = ThisParameterType<Tokenizer>;
type Effects = Parameters<Tokenizer>[0];
type State = Parameters<Tokenizer>[1];
type Code = Parameters<State>[0];

const check = (pattern: RegExp) => (code: Code) => code !== null && code >= 0 && pattern.test(String.fromCharCode(code));
const asciiAlpha = check(/[A-Za-z]/);
const asciiAlphanumeric = check(/[A-Za-z0-9]/);
const unicodePunctuation = check(/\p{P}|\p{S}/u);
const unicodeWhitespace = check(/\s/);
const asciiControl = (code: Code) => code !== null && (code < 32 || code === 127);
const markdownLineEndingOrSpace = (code: Code) => code !== null && (code < 0 || code === 32);
const urlBoundary = check(/[。、，．：；！？・…‥「」『』（）［］【】〈〉《》〔〕｛｝〜‘’“”]/u);
const failedTrailEnds = new WeakMap<TokenizeContext, number>();

const wwwPrefix: Construct = {
  tokenize: tokenizeWwwPrefix,
  partial: true
};
const domain: Construct = {
  tokenize: tokenizeDomain,
  partial: true
};
const path: Construct = {
  tokenize: tokenizePath,
  partial: true
};
const trail: Construct = {
  tokenize: tokenizeTrail,
  partial: true
};
const emailDomainDotTrail: Construct = {
  tokenize: tokenizeEmailDomainDotTrail,
  partial: true
};
const wwwAutolink: Construct = {
  name: 'wwwAutolink',
  tokenize: tokenizeWwwAutolink,
  previous: previousWww
};
const protocolAutolink: Construct = {
  name: 'protocolAutolink',
  tokenize: tokenizeProtocolAutolink,
  previous: previousProtocol
};
const emailAutolink: Construct = {
  name: 'emailAutolink',
  tokenize: tokenizeEmailAutolink,
  previous: previousEmail
};

const text: NonNullable<Extension["text"]> = {};

export function urlAutolinkLiteral(): Extension {
  return {
    text
  };
}

let code: number = 48;

// Add alphanumerics.
while (code < 123) {
  text[code] = emailAutolink;
  code++;
  if (code === 58) code = 65;else if (code === 91) code = 97;
}
text[43] = emailAutolink;
text[45] = emailAutolink;
text[46] = emailAutolink;
text[95] = emailAutolink;
text[72] = [emailAutolink, protocolAutolink];
text[104] = [emailAutolink, protocolAutolink];
text[87] = [emailAutolink, wwwAutolink];
text[119] = [emailAutolink, wwwAutolink];

function tokenizeEmailAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let dot: boolean | undefined;
  let data: boolean;
  return start;

  function start(code: Code): ReturnType<State> {
    if (!gfmAtext(code) || !previousEmail.call(self, self.previous) || previousUnbalanced(self.events)) {
      return nok(code);
    }
    effects.enter('literalAutolink');
    effects.enter('literalAutolinkEmail');
    return atext(code);
  }

  function atext(code: Code): ReturnType<State> {
    if (gfmAtext(code)) {
      effects.consume(code);
      return atext;
    }
    if (code === 64) {
      effects.consume(code);
      return emailDomain;
    }
    return nok(code);
  }

  function emailDomain(code: Code): ReturnType<State> {
    // Dot followed by alphanumerical (not `-` or `_`).
    if (code === 46) {
      return effects.check(emailDomainDotTrail, emailDomainAfter, emailDomainDot)(code);
    }

    // Alphanumerical, `-`, and `_`.
    if (code === 45 || code === 95 || asciiAlphanumeric(code)) {
      data = true;
      effects.consume(code);
      return emailDomain;
    }

    // To do: `/` if xmpp.

    // Note: normally we’d truncate trailing punctuation from the link.
    // However, email autolink literals cannot contain any of those markers,
    // except for `.`, but that can only occur if it isn’t trailing.
    // So we can ignore truncating!
    return emailDomainAfter(code);
  }

  function emailDomainDot(code: Code): ReturnType<State> {
    effects.consume(code);
    dot = true;
    return emailDomain;
  }

  function emailDomainAfter(code: Code): ReturnType<State> {
    // Domain must not be empty, must include a dot, and must end in alphabetical.
    // Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L332>.
    if (data && dot && asciiAlpha(self.previous)) {
      effects.exit('literalAutolinkEmail');
      effects.exit('literalAutolink');
      return ok(code);
    }
    return nok(code);
  }
}

function tokenizeWwwAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  return wwwStart;

  function wwwStart(code: Code): ReturnType<State> {
    if (code !== 87 && code !== 119 || !previousWww.call(self, self.previous) || previousUnbalanced(self.events)) {
      return nok(code);
    }
    effects.enter('literalAutolink');
    effects.enter('literalAutolinkWww');
    // Note: we *check*, so we can discard the `www.` we parsed.
    // If it worked, we consider it as a part of the domain.
    return effects.check(wwwPrefix, effects.attempt(domain, effects.attempt(path, wwwAfter), nok), nok)(code);
  }

  function wwwAfter(code: Code): ReturnType<State> {
    effects.exit('literalAutolinkWww');
    effects.exit('literalAutolink');
    return ok(code);
  }
}

function tokenizeProtocolAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let buffer = '';
  let seen = false;
  return protocolStart;

  function protocolStart(code: Code): ReturnType<State> {
    if ((code === 72 || code === 104) && previousProtocol.call(self, self.previous) && !previousUnbalanced(self.events)) {
      effects.enter('literalAutolink');
      effects.enter('literalAutolinkHttp');
      buffer += String.fromCodePoint(code);
      effects.consume(code);
      return protocolPrefixInside;
    }
    return nok(code);
  }

  function protocolPrefixInside(code: Code): ReturnType<State> {
    // `5` is size of `https`
    if (asciiAlpha(code) && buffer.length < 5) {
      // @ts-expect-error: definitely number.
      buffer += String.fromCodePoint(code);
      effects.consume(code);
      return protocolPrefixInside;
    }
    if (code === 58) {
      const protocol = buffer.toLowerCase();
      if (protocol === 'http' || protocol === 'https') {
        effects.consume(code);
        return protocolSlashesInside;
      }
    }
    return nok(code);
  }

  function protocolSlashesInside(code: Code): ReturnType<State> {
    if (code === 47) {
      effects.consume(code);
      if (seen) {
        return afterProtocol;
      }
      seen = true;
      return protocolSlashesInside;
    }
    return nok(code);
  }

  function afterProtocol(code: Code): ReturnType<State> {
    // To do: this is different from `markdown-rs`:
    // https://github.com/wooorm/markdown-rs/blob/b3a921c761309ae00a51fe348d8a43adbc54b518/src/construct/gfm_autolink_literal.rs#L172-L182
    return code === null || asciiControl(code) || markdownLineEndingOrSpace(code) || unicodeWhitespace(code) || unicodePunctuation(code) ? nok(code) : effects.attempt(domain, effects.attempt(path, protocolAfter), nok)(code);
  }

  function protocolAfter(code: Code): ReturnType<State> {
    effects.exit('literalAutolinkHttp');
    effects.exit('literalAutolink');
    return ok(code);
  }
}

function tokenizeWwwPrefix(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;
  return wwwPrefixInside;

  function wwwPrefixInside(code: Code): ReturnType<State> {
    if ((code === 87 || code === 119) && size < 3) {
      size++;
      effects.consume(code);
      return wwwPrefixInside;
    }
    if (code === 46 && size === 3) {
      effects.consume(code);
      return wwwPrefixAfter;
    }
    return nok(code);
  }

  function wwwPrefixAfter(code: Code): ReturnType<State> {
    // If there is *anything*, we can link.
    return code === null ? nok(code) : ok(code);
  }
}

function tokenizeDomain(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let underscoreInLastSegment: boolean | undefined;
  let underscoreInLastLastSegment: boolean | undefined;
  let seen: boolean | undefined;
  return domainInside;

  function domainInside(code: Code): ReturnType<State> {
    // Check whether this marker, which is a trailing punctuation
    // marker, optionally followed by more trailing markers, and then
    // followed by an end.
    if (code === 46 || code === 95) {
      return effects.check(trail, domainAfter, domainAtPunctuation)(code);
    }

    // GH documents that only alphanumerics (other than `-`, `.`, and `_`) can
    // occur, which sounds like ASCII only, but they also support `www.點看.com`,
    // so that’s Unicode.
    // Instead of some new production for Unicode alphanumerics, markdown
    // already has that for Unicode punctuation and whitespace, so use those.
    // Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L12>.
    if (code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code) || code !== 45 && unicodePunctuation(code)) {
      return domainAfter(code);
    }
    seen = true;
    effects.consume(code);
    return domainInside;
  }

  function domainAtPunctuation(code: Code): ReturnType<State> {
    // There is an underscore in the last segment of the domain
    if (code === 95) {
      underscoreInLastSegment = true;
    }
    // Otherwise, it’s a `.`: save the last segment underscore in the
    // penultimate segment slot.
    else {
      underscoreInLastLastSegment = underscoreInLastSegment;
      underscoreInLastSegment = undefined;
    }
    effects.consume(code);
    return domainInside;
  }

  function domainAfter(code: Code): ReturnType<State> {
    // Note: that’s GH says a dot is needed, but it’s not true:
    // <https://github.com/github/cmark-gfm/issues/279>
    if (underscoreInLastLastSegment || underscoreInLastSegment || !seen) {
      return nok(code);
    }
    return ok(code);
  }
}

function tokenizePath(this: TokenizeContext, effects: Effects, ok: State): State {
  let sizeOpen = 0;
  let sizeClose = 0;
  return pathInside;

  function pathInside(code: Code): ReturnType<State> {
    if (code === 40) {
      sizeOpen++;
      effects.consume(code);
      return pathInside;
    }

    // To do: `markdown-rs` also needs this.
    // If this is a paren, and there are less closings than openings,
    // we don’t check for a trail.
    if (code === 41 && sizeClose < sizeOpen) {
      return pathAtPunctuation(code);
    }

    // Check whether this trailing punctuation marker is optionally
    // followed by more trailing markers, and then followed
    // by an end.
    if (code === 33 || code === 34 || code === 38 || code === 39 || code === 41 || code === 42 || code === 44 || code === 46 || code === 58 || code === 59 || code === 60 || code === 63 || code === 93 || code === 95 || code === 126) {
      return effects.check(trail, ok, pathAtPunctuation)(code);
    }
    if (urlBoundary(code) || code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)) {
      return ok(code);
    }
    effects.consume(code);
    return pathInside;
  }

  function pathAtPunctuation(code: Code): ReturnType<State> {
    // Count closing parens.
    if (code === 41) {
      sizeClose++;
    }
    effects.consume(code);
    return pathInside;
  }
}

function tokenizeTrail(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  if (self.now().offset < (failedTrailEnds.get(self) ?? -1)) return nok;
  const reject: State = code => { failedTrailEnds.set(self, self.now().offset); return nok(code); };
  return trail;

  function trail(code: Code): ReturnType<State> {
    // Regular trailing punctuation.
    if (code === 33 || code === 34 || code === 39 || code === 41 || code === 42 || code === 44 || code === 46 || code === 58 || code === 59 || code === 63 || code === 95 || code === 126) {
      effects.consume(code);
      return trail;
    }

    // `&` followed by one or more alphabeticals and then a `;`, is
    // as a whole considered as trailing punctuation.
    // In all other cases, it is considered as continuation of the URL.
    if (code === 38) {
      effects.consume(code);
      return trailCharacterReferenceStart;
    }

    // Needed because we allow literals after `[`, as we fix:
    // <https://github.com/github/cmark-gfm/issues/278>.
    // Check that it is not followed by `(` or `[`.
    if (code === 93) {
      effects.consume(code);
      return trailBracketAfter;
    }
    if (
    // `<` is an end.
    code === 60 || urlBoundary(code) ||
    // So is whitespace.
    code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)) {
      return ok(code);
    }
    return reject(code);
  }

  function trailBracketAfter(code: Code): ReturnType<State> {
    // Whitespace or something that could start a resource or reference is the end.
    // Switch back to trail otherwise.
    if (code === null || code === 40 || code === 91 || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)) {
      return ok(code);
    }
    return trail(code);
  }

  function trailCharacterReferenceStart(code: Code): ReturnType<State> {
    // When non-alpha, it’s not a trail.
    return asciiAlpha(code) ? trailCharacterReferenceInside(code) : reject(code);
  }

  function trailCharacterReferenceInside(code: Code): ReturnType<State> {
    // Switch back to trail if this is well-formed.
    if (code === 59) {
      effects.consume(code);
      return trail;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return trailCharacterReferenceInside;
    }

    // It’s not a trail.
    return reject(code);
  }
}

function tokenizeEmailDomainDotTrail(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return start;

  function start(code: Code): ReturnType<State> {
    // Must be dot.
    effects.consume(code);
    return after;
  }

  function after(code: Code): ReturnType<State> {
    // Not a trail if alphanumeric.
    return asciiAlphanumeric(code) ? nok(code) : ok(code);
  }
}

function previousWww(code: Code): boolean {
  return code === null || code === 40 || code === 42 || code === 95 || code === 91 || code === 93 || code === 126 || markdownLineEndingOrSpace(code);
}

function previousProtocol(code: Code): boolean {
  return !asciiAlpha(code);
}

function previousEmail(code: Code): boolean {
  // Do not allow a slash “inside” atext.
  // The reference code is a bit weird, but that’s what it results in.
  // Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L307>.
  // Other than slash, every preceding character is allowed.
  return !(code === 47 || gfmAtext(code));
}

function gfmAtext(code: Code): boolean {
  return code === 43 || code === 45 || code === 46 || code === 95 || asciiAlphanumeric(code);
}

// Cache the pending label stack on token identities. Keep positive states too:
// rescanning back to an unmatched '[' for every URL would be quadratic.
type LabelToken = TokenizeContext["events"][number][1];
type Labels = { token: LabelToken; before: Labels | null };
const labelStates = new WeakMap<LabelToken, Labels | null>();
function previousUnbalanced(events: TokenizeContext["events"]): boolean {
  const pending: LabelToken[] = [];
  let labels: Labels | null = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const [kind, token] = events[index];
    if (labelStates.has(token)) { labels = labelStates.get(token)!; break; }
    if (kind === "enter" && (token.type === "labelLink" || token.type === "labelImage") && !token._balanced) pending.push(token);
  }
  for (let index = pending.length - 1; index >= 0; index--) labels = { token: pending[index], before: labels };
  while (labels?.token._balanced) labels = labels.before;
  if (events.length) labelStates.set(events[events.length - 1][1], labels);
  return labels !== null;
}
