---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Erase agent email mail with its conversation, and erase an email correspondent by address. A thread erasure now also erases the inbox mail behind an email-born conversation, received or sent up to the cutoff, and an erasure reports `emailMessagesErased` and `emailThreadsErased` and starts in the new `mail` phase. `emailEndUserId(address)` returns the end-user id that names an email correspondent, such as `channel:email:-:alice%40example.com`, and `deployments end-user erase --email <address>` sends it in place of `--end-user-id`. An end-user erasure for an email subject reaches every message and draft that names the address, including mail that never started a conversation. Erasing one of your own inbox addresses is refused with `end_user_is_inbox`.
