/** The only code points whose NFKC form contains "<". */
const TAG_OPENERS = /[<\uFE64\uFF1C]/gu;
const TAG_CHARACTERS = /^[\s/a-z_-]+$/iu;
const ATTACHED_FILE_TAG = /^\s*\/?\s*attached[\s_-]*file/iu;

export function escapeAttachedFileTags(text: string): string {
  return text.replace(TAG_OPENERS, (opener: string, offset: number) => {
    let span = "";
    for (const character of text.slice(offset + opener.length)) {
      const folded = character.normalize("NFKC");
      if (!TAG_CHARACTERS.test(folded)) break;
      span += folded;
    }
    return ATTACHED_FILE_TAG.test(span) ? `${opener}\\` : opener;
  });
}
