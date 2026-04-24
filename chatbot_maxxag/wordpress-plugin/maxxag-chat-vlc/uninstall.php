<?php
/**
 * Uninstall — runs when the plugin is deleted from WordPress admin.
 * Cleans up ALL data: options, transients, and private data directory.
 */
if (!defined('WP_UNINSTALL_PLUGIN')) exit;

global $wpdb;

// 1. Delete all plugin options
delete_option('maxxag_enabled');
delete_option('maxxag_lang');
delete_option('maxxag_admin_token');
delete_option('maxxag_anthropic_key');
delete_option('maxxag_sessions');

// 2. Delete all plugin transients (sessions, rate limits, brute-force, cache)
$wpdb->query(
    "DELETE FROM {$wpdb->options}
     WHERE option_name LIKE '\\_transient\\_maxxag\\_%'
        OR option_name LIKE '\\_transient\\_timeout\\_maxxag\\_%'"
);

// 3. Delete the private data directory recursively
$data_dir = WP_CONTENT_DIR . '/uploads/maxxag-private';
if (is_dir($data_dir)) {
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($data_dir, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($files as $file) {
        if ($file->isDir()) {
            @rmdir($file->getRealPath());
        } else {
            @unlink($file->getRealPath());
        }
    }
    @rmdir($data_dir);
}
