# Changelog

## 0.0.1 (unreleased)

First packaged build.

- `.fcl` language support: highlighting, `#` comment toggling, bracket matching.
- Live syntax checking of the open file (grammar follows fhicl-cpp; no `#include` following).
- Outline, `#include` links, and go-to-definition / hover / completion for names in the current file,
  including art module labels and path names in path lists.
- Resolved-configuration preview: a title-bar button runs `fhicl-dump` and shows the result in a side panel
  (collapsible, Ctrl+F search, each value linked to where it was set). Runs only when clicked.
- Named environments (`fhicl.environments`), chosen per window from the status bar; Apptainer/UPS/mrb setups;
  optional `cachedHost` mode that runs `fhicl-dump` on the host from a captured environment.
