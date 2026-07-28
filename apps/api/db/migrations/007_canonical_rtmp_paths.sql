-- Preserve each existing stream key while making /live/ the single public
-- publication path. This migration is idempotent and does not remove cameras.
UPDATE cameras
SET
  rtsp_url = regexp_replace(
    rtsp_url,
    '^(rtmp://[^/]+/)(live/|normalized/)?([^/]+)$',
    '\1live/\3'
  ),
  updated_at = NOW()
WHERE source_type = 'rtmp'
  AND rtsp_url IS NOT NULL
  AND rtsp_url ~ '^rtmp://[^/]+/(live/|normalized/)?[^/]+$'
  AND rtsp_url !~ '^rtmp://[^/]+/live/[^/]+$';
