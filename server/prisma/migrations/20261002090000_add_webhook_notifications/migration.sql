-- AlterTable
ALTER TABLE `User` ADD COLUMN `notificationEmailEnabled` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `WebhookTarget` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `url` VARCHAR(2048) NOT NULL,
    `method` VARCHAR(7) NOT NULL DEFAULT 'POST',
    `headers` JSON NOT NULL,
    `bodyTemplate` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WebhookTarget_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `targetName` VARCHAR(191) NOT NULL,
    `targetUrl` VARCHAR(2048) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `purpose` ENUM('TEST_EMAIL', 'VERIFY_EMAIL', 'PASSWORD_RESET', 'CERT_ALERT') NOT NULL,
    `subject` TEXT NOT NULL,
    `preview` TEXT NULL,
    `error` TEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WebhookLog_userId_requestedAt_idx`(`userId`, `requestedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WebhookTarget` ADD CONSTRAINT `WebhookTarget_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookLog` ADD CONSTRAINT `WebhookLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
