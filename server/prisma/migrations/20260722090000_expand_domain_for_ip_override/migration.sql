-- Allow certificate targets to include a curl-style hostname:port:ip override.
ALTER TABLE `Domain`
  MODIFY `domain` VARCHAR(320) NOT NULL;
