# Glossary

## md-log

- **Generated placement**: A pending marker and its metadata that connect a generated attachment to a location in the linked note until the output is validated and embedded.
- **Anchor occurrence**: The specific occurrence of transcript text targeted by a Generated placement. New placements retain a hidden stable ID beside it; legacy placements fall back to text, while missing or duplicated IDs require a unique match or explicit recovery.
- **Unresolved placement**: A generated placement whose output is malformed, missing, or no longer matches its note anchor. Keep its marker until it is resolved or the user explicitly chooses to remove it.

## Mastery

- **Mastery evidence**: A completed interaction judged useful for assessing one canonical concept, stored as a compact append-only event with its full interaction ID, score, confidence, weight, and descriptive outcome.
- **Baseline assessment**: A purposeful check of current understanding before choosing a learning sequence. It is a session purpose, not a separate question format; use existing quiz or free-response interactions.
- **Assessment round**: A bounded set of individually recorded interactions for one concept, followed by one weighted synthesis event describing coverage and rationale. The synthesis supplements rather than replaces its source interactions.
- **Mastery projection**: The weighted score and evidence metadata written to linked-note frontmatter by replaying the canonical mastery evidence journal.
