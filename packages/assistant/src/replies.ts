export interface ReplyButton {
  label: string;
  url?: string;
  token?: string;
  choiceGroup?: string;
}
export interface ReplyCard {
  text: string;
  poster?: string;
  buttons?: ReplyButton[];
}
export function cardMarkdown(card: ReplyCard): string {
  if (!card.poster) return card.text;
  const url = new URL(card.poster);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "image.tmdb.org",
      "artworks.thetvdb.com",
      "assets.fanart.tv",
      "images.fanart.tv",
    ].includes(url.hostname)
  )
    throw new Error("Use a public poster URL supplied by LeoLab MCP");
  // Escape Markdown delimiters without changing the artwork URL's meaning.
  return `![Film poster](${url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})\n${card.text}`;
}
