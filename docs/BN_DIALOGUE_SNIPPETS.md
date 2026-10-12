# BN dialogue snippets and goodbye

The default TALK_DONE/TALK_NONE goodbye is BN's literal translated "Bye." (npctalk.cpp1371–1372, also1266–1267 when exiting conversation). The previous DDA end_talking_bye category does not exist in the extracted BN snippets. Optional custom template/class snippet overrides remain supported.

The previously skipped punctuation case now exercises actual extracted BN categories <swear!> and <no>, checks membership in their real snippet pools, and verifies unknown categories stay intact. DDA punc categories are absent from BN data and are not invented. The existing restock-time formatting assertion remains. All28 NPC tests and typecheck pass.
