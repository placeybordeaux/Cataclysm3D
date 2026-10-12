# Legacy dormant corpse spawn compatibility

The existing custom-generator pseudo_dormant_* and mon_pseudo_dormant_* spawn aliases now validate their decoded real monster definition before applying spawn density. Previously request validation rejected the absent pseudo ID before reaching the already implemented dormant corpse placement path.

This is compatibility for the existing generator extension, not newly extracted BN content. The current BN data has no dormant-zombie pseudo definitions. No invented monster definitions or mapgen content are added. Unknown decoded monster IDs still warn and do not spawn.

The previously skipped regression now actually creates corpses, checks clean-chunk baseline, eviction/stash/regeneration counts, and revival on approach. The clean-chunk save test also asserts nonzero real fat-zombie dormant corpses, then verifies two compressed save/load cycles preserve their exact count without duplicate ground items. Previously that test silently passed with zero corpses. Save/monster integration tests and typecheck pass.
