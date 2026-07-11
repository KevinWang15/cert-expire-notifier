-- Add email verification, password reset, and richer email delivery tracking.
ALTER TABLE `User`
  ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL;

-- Existing users predate verification, so keep them able to sign in after migration.
UPDATE `User` SET `emailVerifiedAt` = CURRENT_TIMESTAMP(3) WHERE `emailVerifiedAt` IS NULL;

ALTER TABLE `EmailLog`
  ADD COLUMN `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `status` ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'SENT',
  ADD COLUMN `purpose` ENUM('CERT_EXPIRY', 'TEST_EMAIL', 'VERIFY_EMAIL', 'PASSWORD_RESET') NOT NULL DEFAULT 'CERT_EXPIRY',
  ADD COLUMN `toEmail` VARCHAR(191) NULL,
  ADD COLUMN `preview` TEXT NULL,
  ADD COLUMN `error` TEXT NULL,
  ADD COLUMN `updatedAt` DATETIME(3) NULL;

ALTER TABLE `EmailLog`
  MODIFY `sentAt` DATETIME(3) NULL DEFAULT NULL,
  MODIFY `domains` TEXT NULL;

UPDATE `EmailLog`
INNER JOIN `User` ON `User`.`id` = `EmailLog`.`userId`
SET
  `EmailLog`.`toEmail` = `User`.`email`,
  `EmailLog`.`requestedAt` = COALESCE(`EmailLog`.`sentAt`, CURRENT_TIMESTAMP(3)),
  `EmailLog`.`status` = CASE WHEN `EmailLog`.`sentAt` IS NULL THEN 'PENDING' ELSE 'SENT' END,
  `EmailLog`.`purpose` = 'CERT_EXPIRY',
  `EmailLog`.`updatedAt` = COALESCE(`EmailLog`.`sentAt`, CURRENT_TIMESTAMP(3));

ALTER TABLE `EmailLog`
  MODIFY `toEmail` VARCHAR(191) NOT NULL,
  MODIFY `updatedAt` DATETIME(3) NOT NULL;

CREATE INDEX `EmailLog_userId_requestedAt_idx` ON `EmailLog`(`userId`, `requestedAt`);
CREATE INDEX `EmailLog_userId_status_requestedAt_idx` ON `EmailLog`(`userId`, `status`, `requestedAt`);
CREATE INDEX `EmailLog_userId_purpose_sentAt_idx` ON `EmailLog`(`userId`, `purpose`, `sentAt`);

CREATE TABLE `EmailVerificationToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailVerificationToken_tokenHash_key`(`tokenHash`),
    INDEX `EmailVerificationToken_userId_expiresAt_idx`(`userId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PasswordResetToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PasswordResetToken_tokenHash_key`(`tokenHash`),
    INDEX `PasswordResetToken_userId_expiresAt_idx`(`userId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `EmailVerificationToken` ADD CONSTRAINT `EmailVerificationToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `PasswordResetToken` ADD CONSTRAINT `PasswordResetToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
