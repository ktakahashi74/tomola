import { describe, expect, it } from "vitest";
import { typesetText, englishWordParts } from "~/lib/typeset-text";
import { renderMarkdown, renderEntry } from "~/lib/markdown.server";
import { renderEntryHtml, renderTranslationHtml, tryRenderTranslationHtml } from "~/lib/entries.server";
import { LANGS } from "~/lib/languages";
import { TARGET_LANG_SPECS } from "~/lib/llm/lang-specs";
import { buildTranslationPrompt } from "~/lib/llm/prompt.server";

describe("translation typography", () => {
  it.each(["en", "fr", "de", "es", "pt", "id", "vi", "ru"])("typesets apostrophes and ellipses in %s", lang => {
    expect(typesetText("l'IA don't Россия'я ...", lang)).toBe("l’IA don’t Россия’я …");
    expect(typesetText("'90s members' 1'2", lang)).toBe("'90s members' 1'2");
  });
  it.each([["en", "“a” and “b”"], ["de", "„a“ and „b“"], ["fr", "«\u00a0a\u00a0» and «\u00a0b\u00a0»"]])("pairs quotes for %s, and leaves odd counts alone", (lang, expected) => {
    expect(typesetText('"a" and "b"', lang)).toBe(expected);
    expect(typesetText('"a" and "b', lang)).toBe('"a" and "b');
  });
  it.each(["en", "de", "fr"])("preserves uncertain quote positions across the whole paragraph in %s", lang => {
    for (const text of ['12" disk and 3.5" disk', '"Le "Grand" Bleu"', '"Le " Grand " Bleu"', '"good" and 12" disk and 3.5" disk "last"', 'prefix"word"', '"word"suffix', '" word "']) {
      expect(typesetText(text, lang)).toBe(text);
      expect(typesetText(typesetText(text, lang), lang)).toBe(text);
    }
    const expected = lang === "en" ? 'He said “hello”.' : lang === "de" ? 'He said „hello“.' : 'He said «\u00a0hello\u00a0».';
    expect(typesetText('He said "hello".', lang)).toBe(expected);
  });
  it("inserts French non-breaking spaces without touching time and addresses", () => {
    expect(typesetText('Salut! oui ? non; texte: «mot» 12:30 https://example.com/a?x=1', "fr"))
      .toBe('Salut\u202f! oui\u202f? non\u202f; texte\u00a0: «\u00a0mot\u00a0» 12:30 https://example.com/a?x=1');
    expect(typesetText('« déjà » «\u00a0prêt\u00a0» mot  !', "fr")).toBe('«\u00a0déjà\u00a0» «\u00a0prêt\u00a0» mot\u202f!');
    expect(typesetText('before «https://example.com/» after', "fr")).toBe('before «\u00a0https://example.com/\u00a0» after');
    expect(typesetText('«mot»! mot:oui', "fr")).toBe('«\u00a0mot\u00a0»\u202f! mot:oui');
  });
  it("limits French spacing to prose endings and preserves bare technical notation", () => {
    const notation = String.raw`localhost:8080 std::vector key:value C:\dir doi:10.1000/x foo;bar !word word!next word?next`;
    expect(typesetText(notation, "fr")).toBe(notation);
    for (const punctuation of [":", ";", "!", "?"]) for (const ending of ["", " next", ")", "»", "”", "]"]) {
      const text = `mot${punctuation}${ending}`;
      const expected = `mot${punctuation === ":" ? "\u00a0" : "\u202f"}${punctuation}${ending === "»" ? "\u00a0»" : ending}`;
      expect(typesetText(text, "fr")).toBe(expected);
      expect(typesetText(expected, "fr")).toBe(expected);
    }
  });
  it.each(["ja", "zh-Hans", "zh-Hant"])("widens contextual punctuation in %s and preserves numbers and English prose", lang => {
    expect(typesetText("機械学習(ML) どうですか? 答:中文;重要! (中文) word(test) foo(中文)bar 12:30 1,234 0.25", lang))
      .toBe("機械学習（ML） どうですか？ 答：中文；重要！ （中文） word(test) foo(中文)bar 12:30 1,234 0.25");
  });
  it.each(["ja", "zh-Hans", "zh-Hant"])("preserves ASCII-attached bracket pairs in %s", lang => {
    const text = "f(x)の値 関数f(x)とg(y) API(略)は 1(注) 機械学習(ML) (注)これは これ(笑)";
    const expected = "f(x)の値 関数f(x)とg(y) API(略)は 1(注) 機械学習（ML） （注）これは これ（笑）";
    expect(typesetText(text, lang)).toBe(expected);
    expect(typesetText(expected, lang)).toBe(expected);
  });
  it("protects URLs, mentions and code/math notation in short plain titles", () => {
    const title = 'n\'a ... `n\'a ...` $x:y$ @internationalization https://example.com/a?...';
    expect(typesetText(title, "fr")).toBe('n’a … `n\'a ...` $x:y$ @internationalization https://example.com/a?...');
    expect(typesetText('HTTPS://example.com/l\'IA?... custom+v1://example.com/a?...', "fr")).toBe('HTTPS://example.com/l\'IA?... custom+v1://example.com/a?...');
  });
  it("is idempotent for every rule and leaves unsupported languages unchanged", () => {
    const texts = ["n'a ... .... ..... ......", '"a" and "b"', '« déjà » mot  ! 12:30', "機械学習(ML) どうですか? 中文:文字", "中文!? ((中文)): 文!!"];
    for (const lang of [...LANGS, "es", "pt", "id", "ru"]) for (const text of texts) {
      const once = typesetText(text, lang);
      expect(typesetText(once, lang)).toBe(once);
    }
    expect(typesetText('"a" ... n\'a!', "ko")).toBe('"a" ... n\'a!');
  });
  it("handles large quote, space and parenthesis runs completely", () => {
    const source = ('"word"' + ' '.repeat(200) + ': 機械学習(ML) ').repeat(3000);
    expect(typesetText(source, "fr")).toBe('«\u00a0word\u00a0»\u00a0: 機械学習(ML) '.repeat(3000));
    expect(typesetText(source, "ja")).toBe(('"word"' + ' '.repeat(200) + ': 機械学習（ML） ').repeat(3000));
  });
  it("adds target typography and preservation rules to future prompts", () => {
    for (const lang of LANGS) {
      const prompt = buildTranslationPrompt({ from: "en", to: lang, text: "source" });
      expect(prompt.system).toContain(TARGET_LANG_SPECS[lang]!);
      expect(prompt.system).toContain("Preserve code, URLs, formulas and Markdown syntax");
    }
  });
});

describe("typography in the Markdown worker", () => {
  it("keeps inline ranges, pairs quotes across emphasis, and checks parity per paragraph", async () => {
    const html = await renderMarkdown('"One **bold** [label](https://example.com/a?... )"...\n\n"odd\n\n"two"', { lang: "fr", translation: true });
    expect(html).toContain('«\u00a0One <strong>bold</strong> <a href="https://example.com/a?...">label</a>\u00a0»…');
    expect(html).toContain('<p>"odd</p>');
    expect(html).toContain('<p>«\u00a0two\u00a0»</p>');
  });
  it("excludes code, math, URL labels, mentions and image descriptions", async () => {
    const md = 'n\'a ... `n\'a ...`\n\n```txt\nn\'a ...\n```\n\n$x:y$ https://example.com/a?... [https://example.com/a?...](https://example.com/) @internationalization ![n\'a ...](https://example.com/img.png)';
    const mentions = new Map([["internationalization", { handle: "internationalization", userId: "member", publicId: "abcdefgh1234" }]]);
    const before = await renderMarkdown(md, { lang: "fr", mentions });
    const after = await renderMarkdown(md, { lang: "fr", translation: true, mentions });
    expect(after).toContain("n’a … <code>n'a ...</code>");
    expect(after).toContain("<code class=\"language-txt\">n'a ...\n</code>");
    const mathOnly = await renderMarkdown('$x:y$', { lang: "fr", translation: true });
    expect(mathOnly).toBe(await renderMarkdown('$x:y$', { lang: "fr" }));
    expect(after).toContain('class="mention" href="/u/id/abcdefgh1234">@internationalization</a>');
    expect(after).toContain('>https://example.com/a?...</a>');
    expect(after).toContain('>n\'a ...</a>');
    expect(await renderMarkdown('Before "`x`" and "@internationalization" after.', { lang: "fr", translation: true, mentions }))
      .toContain('Before «\u00a0<code>x</code>\u00a0» and «\u00a0<a class="mention" href="/u/id/abcdefgh1234">@internationalization</a>\u00a0» after.');
  });
  it("marks long English words in CJK source and translation without changing source text", async () => {
    const source = '日本語internationalizationとshort。 `internationalization` $internationalization$ https://example.com/internationalization @internationalization [説明internationalization](https://example.com/)';
    for (const lang of ["ja", "zh-Hans", "zh-Hant"]) {
      const html = (await renderEntryHtml("topic", 1, source, lang, new Map())).html;
      expect(html).toContain('日本語<span lang="en">internationalization</span>とshort。');
      expect(html).toContain('<code>internationalization</code>');
      expect(html).toContain(' @internationalization ');
      expect(html).toContain('>https://example.com/internationalization</a>');
      expect(html).toContain('説明<span lang="en">internationalization</span>');
    }
    expect(await renderMarkdown(source, { lang: "en" })).not.toContain('<span lang="en">');
    expect(await renderMarkdown('abcdefgh**ijklmnop** inter**nationalization**', { lang: "ja" })).not.toContain('<span lang="en">');
    expect(englishWordParts("abcdefgh1 _abcdefgh éabcdefgh internationalization")).toEqual(["abcdefgh1 _abcdefgh ", { word: "éabcdefgh" }, " ", { word: "internationalization" }]);
    const fullWidth = 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ';
    expect(englishWordParts(fullWidth)).toEqual([fullWidth]);
    expect(await renderMarkdown(fullWidth, { lang: "ja" })).toBe(`<p>${fullWidth}</p>`);
  });
  it("drops member HTML attributes and leaves source and human translation characters intact", async () => {
    const raw = '<span lang="en" class="evil" onclick="alert(1)">short</span> 機械学習(ML)';
    const source = (await renderEntryHtml("reply", 1, raw, "ja", new Map())).html;
    expect(source).not.toMatch(/<span|onclick|evil/);
    expect(source).toContain("機械学習(ML)");
    expect((await renderTranslationHtml("reply", 1, "ja", raw, new Map())).html).toBe(source);
    expect((await renderTranslationHtml("reply", 1, "ja", raw, new Map(), true)).html).toContain("機械学習（ML）");
    expect((await tryRenderTranslationHtml("reply", 1, "fr", "n'a ...", new Map(), true))?.html).toContain("n’a …");
  });
  it("uses both language and translation mode in worker and processor cache keys, including cards", async () => {
    const md = '"word"... ' + "paragraph ".repeat(500);
    const en = await renderEntry(md, { lang: "en", translation: true });
    const de = await renderEntry(md, { lang: "de", translation: true });
    const original = await renderEntry(md, { lang: "en" });
    expect(en.html).toContain("“word”…");
    expect(en.cardHtml).toContain("“word”…");
    expect(de.html).toContain("„word“…");
    expect(original.html).toContain('"word"...');
  });
});
