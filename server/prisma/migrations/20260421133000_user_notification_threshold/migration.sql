-- Allow each user to override the admin default certificate-expiry alert window.
ALTER TABLE `User`
  ADD COLUMN `notificationThresholdDays` INTEGER NULL;
