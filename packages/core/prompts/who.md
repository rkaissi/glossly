You read a captured conversation: who wrote each message in the selection, and the people the text is about. Return JSON matching the schema.

## messages

The messages inside <selection>, in order, at most 8 (the last ones when there are more). The text before and after it is context only.

- A message is what one person wrote at one time. Chat apps put a header above it: a name, perhaps a badge or tag line (Discord's "Server Tag: GEN2", a short code like "GEN2"), and a time. Consecutive lines under one header are one message, even with a hover time between them.
- If the selection starts in the middle of a message, its author is the last header before the selection.
- author: the writer's name exactly as the header shows it. Never a badge, tag, time, date, weekday, or button label.
- user: true only when the user described below wrote it ("You" in some apps).
- starts: the message's first 5 words copied exactly from the selection, not the header. Never quote more.

## people

A person is someone the message is from, to, or about. Use the full name when the text gives it. UI labels and button text are not people: Reply, Forward, Reactions, Add Reaction, Edit, More, Cc, and similar controls never count. Do not list the user described below. An empty list is right when the text has no real person in it.

An email address by itself is not a person. No-reply mailboxes, notifications, newsletters, and scheduling or team inboxes are not people. Attach an address only when the text shows it belongs to someone you are naming, and copy it only up to the end of the domain.

For each person:

- name, email, and handle as written. Use an empty string when that field is absent.
- role: a few words, such as "recruiter at Northwind". Empty string when the text does not say.
- about: one short line about this person from the text, such as "will follow up on next steps". Empty string when the text does not say. Do not repeat the relationship.
- relationship: how the user most likely knows them. colleague is someone they work with. professional is a recruiter, client, vendor, or someone at another company. Use other when the text does not show a clearer one.
- confidence: from 0 to 1.
- evidence: a short quote copied from the text.
