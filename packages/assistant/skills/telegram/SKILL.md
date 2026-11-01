---
name: telegram
description: Formatting guidance for Telegram replies.
---
Use Telegram rich Markdown. Use bold for emphasis; avoid other emphasis styles.

Bold: `**Service is running**`

Bulleted list:
```text
- Picard
- Laforge
```

Numbered list:
```text
1. Check the service
2. Review the logs
```

Inline code: `` `systemctl status` ``

Code block, with a language when known:
````text
```bash
systemctl status leolab-assistant
```
````

Descriptive link: `[Telegram Bot API](https://core.telegram.org/bots/api)`

Compact table:
```text
| Service | Status |
|---------|--------|
| Gateway | Running |
```

Quote:
```text
> The backup completed successfully.
```

Expandable quote:
```text
<blockquote expandable>First line<br>More details</blockquote>
```

Collapsible section:
```text
<details><summary>More details</summary>
Additional information goes here.
</details>
```

Spoiler: `||The hidden plot detail||`

Localized date and time: `![17 March 2022, 15:45 UTC](tg://time?unix=1647531900&format=wDT)`

## Reply delivery

Ordinary text output is delivered as one reply after the agent run finishes; intermediate assistant text is not sent to Telegram. The host prepends session/context notices to the answer and reacts with 👀 if answering takes more than three seconds. Do not duplicate those notices in your answer or send a working reaction yourself. Use `react_to_message` when a reaction is itself an appropriate response to what the user said.

For film search results, use `telegram_cards` with one card per film. Each card becomes a separate Telegram message with its own buttons below it. The card list replaces ordinary text delivery; final assistant text is not sent as an additional message. Put all result content in the cards, without a separate introduction card, closing card, or explanation of where the buttons are. Calling this tool prepares the answer without sending it immediately; calling again replaces the entire list. After preparing the complete card list, finish the turn.

Map the content selected under the system's media guidance into these fields:

- `poster`: the supplied `images.poster.url`, when present.
- `text`: the title and year in bold, followed by the concise description, useful facts and library/request status. Do not repeat the poster URL in the text.
- `buttons`: the individual actions to offer for this result. A choice button sends its visible label as the next user message, so the label must fully describe the action and identify the film, for example `Request Dune (2021)`.

Use `telegram_buttons` to attach choices or HTTPS links to an ordinary text reply. Buttons appear below that reply's text. Use `telegram_cards` for per-card buttons rather than combining it with `telegram_buttons`.
