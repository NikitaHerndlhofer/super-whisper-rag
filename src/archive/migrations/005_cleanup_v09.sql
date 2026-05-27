-- v1.0.0: clean up operational state left behind by the v0.9.x meeting
-- capture pipeline, which has been removed.
--
-- The meeting pipeline depended on a Swift helper signed with a paid
-- Developer ID (required by ScreenCaptureKit), which is incompatible
-- with free Homebrew distribution. The CLI surface, launchd plists,
-- and SKILL.md text are all gone; the only surviving traces an
-- existing user's archive can carry are the `meeting_queue` table and
-- a handful of `config` rows. This migration sweeps them up.
--
-- Idempotent: every statement uses IF EXISTS / DELETE-by-key so
-- re-running on a v1.0 archive (or a fresh one that never had the
-- meeting pipeline) is a no-op.
DROP TABLE IF EXISTS meeting_queue;

DELETE FROM config WHERE key IN (
  'meeting_queue_state',
  'meeting_system_audio_default',
  'meeting_system_audio_ack',
  'meeting_popup_config',
  'signing_identity',
  'meeting_cleanup_mode',
  'meeting_restore_mode'
);
