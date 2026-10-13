# Producer skills

Versioned guidance packs that producer sessions load while they write scripts, storyboards and
revisions. Each skill is a directory with a `skill.json` manifest (`name`, `kind`, `description`)
and a `SKILL.md`. Recipes live under `recipes/` and have kind `recipe`; a format can name one in
its rules.

The studio agent prefers skills synced from the server (`~/Loomcast/skills/<name>/`) and falls
back to these bundled copies. They are plain text with no vendor-specific instructions, and they
never ask a session to render, download media or run commands.
