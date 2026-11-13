# Learned Regressions

Classes of finding from Crucible reviews and build-side wraps. A pattern recurring in a second PR is proposed as a rule.

### convention-tool-schema-follows-handler
- **Pattern:** A handler's behavior widened (a file now read in more cases, a field now honored) while the tool schema's parameter description still states the narrower behavior, so a caller following the schema gets a result it was told it would not.
- **Occurrences:** 1 (PR #2: flow_check's project_path said the file is read only when workflow_state is omitted; triggers now read it always)
- **Status:** watching
