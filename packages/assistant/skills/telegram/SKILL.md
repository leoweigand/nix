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

## Reply behavior

Minimize the number of messages. Do not send an acknowledgement, progress update, separate introduction, or a message explaining where buttons are. The host adds session/context notices to the top of the answer and reacts with 👀 if answering takes more than two seconds; do not duplicate those notices or send a working reaction yourself. Use `react_to_message` only when a reaction is itself an appropriate response to what the user said.

For film search results, use `telegram_cards` to prepare the complete answer: one card per relevant film, with no additional text message. Calling this tool prepares the answer; it does not send it immediately. After it succeeds, finish the turn without calling `telegram_buttons`. Use:

- `poster`: the exact public `images.poster.url` supplied by MCP, when available. Omit it when missing; still show the film.
- `text`: the film's bold title and year, a brief synopsis, useful supplied facts such as runtime or genres, and its current library/request status. Keep each card concise and omit missing facts. Put the title before the description; do not repeat the poster URL in the text.
- `buttons`: that film's individual action, such as `Request Dune (2021)`. Include the title and year so the label is an unambiguous next user request. Offer a request only when the returned facts and permitted actions support it; inspect details when eligibility is unclear. For available or already requested films, show the status instead of offering a redundant request.

Never offer “Request both” or “Request all” for an ordinary lookup. Each film can be selected independently. Do not silently leave out a relevant result merely because it is already in the library. Only use catalog facts returned by the tools.

For ordinary replies, return one concise rich Markdown answer. Use `telegram_buttons` if that single reply needs choices or HTTPS links. These buttons accompany the answer below its text; do not describe them as already sent or located above it.
