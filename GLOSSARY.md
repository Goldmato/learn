# Glossary

## md-log

- **Generated placement**: A pending marker and its metadata that connect a generated attachment to a location in the linked note until the output is validated and embedded.
- **Anchor occurrence**: The specific occurrence of transcript text targeted by a Generated placement. New placements retain a hidden stable ID beside it; legacy placements fall back to text, while missing or duplicated IDs require a unique match or explicit recovery.
- **Unresolved placement**: A generated placement whose output is malformed, missing, or no longer matches its note anchor. Keep its marker until it is resolved or the user explicitly chooses to remove it.
