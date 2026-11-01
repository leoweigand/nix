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
