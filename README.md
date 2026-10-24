The list of addons the site was last built with, as one file: addons.json.

publication.json records its application commit, full snapshot fingerprint
and confirmed Pages deployment. It contains no private queue data.

Written by the Deploy workflow on the main branch. Visitors read the list from this
file, and it stands in when the database cannot be reached. It holds what any
visitor may see and nothing else.

The branch is always a single commit that replaces the one before, so it has no
history: an addon deleted from the site is gone from here with the next snapshot.
