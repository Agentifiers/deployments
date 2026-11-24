---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

An agent can read documents from earlier turns of a thread. On a later turn, the model sees a list of up to 12 documents that earlier messages attached, newest first, with each file's name, summary, text size, artifact ID, and how many turns ago it arrived, and it reads their text with `attachment.read`. The document text itself is never replayed into history. A document stays on the list while its message is in the recent history the model sees and among the thread's newest 400 messages, and while its retention lasts. The list and the tool cover only files the run's caller may read: the same person's or service account's uploads, or the files the same channel binding captured. Another caller in the thread sees neither. An agent email binding's turn lists nothing and reads only the files its own email attached, because anyone who knows an email thread's first message ID can reply into it.
