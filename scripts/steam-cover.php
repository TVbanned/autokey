<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

function fail($message, $status = 400) {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function downloadSteamHeader($url, $temporary) {
    $stream = fopen($temporary, 'wb');
    if (!$stream) return false;
    $handle = curl_init($url);
    curl_setopt_array($handle, [
        CURLOPT_FILE => $stream,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => 'GameJourney/1.0',
    ]);
    $ok = curl_exec($handle);
    $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);
    fclose($stream);
    if (!$ok || $status !== 200 || !is_file($temporary) || filesize($temporary) < 1024 || filesize($temporary) > 3 * 1024 * 1024) {
        @unlink($temporary);
        return false;
    }
    $image = @getimagesize($temporary);
    if (($image['mime'] ?? '') !== 'image/jpeg') {
        @unlink($temporary);
        return false;
    }
    return true;
}

function steamChineseHeaderUrl($appId) {
    $apiUrl = 'https://store.steampowered.com/api/appdetails?appids=' . $appId . '&l=schinese&cc=cn';
    $handle = curl_init($apiUrl);
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_USERAGENT => 'GameJourney/1.0',
    ]);
    $body = curl_exec($handle);
    $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);
    $header = json_decode($body ?: '', true)[$appId]['data']['header_image'] ?? '';
    return $status === 200 && is_string($header) && str_starts_with($header, 'https://') ? $header : '';
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('仅支持 POST 请求', 405);
$input = json_decode(file_get_contents('php://input'), true);
$appId = (string)($input['appId'] ?? '');
$sourceUrl = (string)($input['sourceUrl'] ?? '');
if (!preg_match('/^\d{1,10}$/', $appId)) fail('无效的 Steam App ID');
$sourceHost = parse_url($sourceUrl, PHP_URL_HOST);
$trustedSourceUrl = str_starts_with($sourceUrl, 'https://') && preg_match('/(^|\.)steamstatic\.com$/', (string)$sourceHost) ? $sourceUrl : '';

$directory = '/www/wwwroot/39.96.61.144/AutokeyProject/media/game-covers';
$filename = 'steam-' . $appId . '-schinese-v3.jpg';
$path = $directory . '/' . $filename;
if (is_file($path) && filesize($path) > 0) {
    echo json_encode(['url' => 'https://palewinds.com/media/game-covers/' . $filename], JSON_UNESCAPED_UNICODE);
    exit;
}
if (!is_dir($directory) && !mkdir($directory, 0755, true)) fail('创建封面目录失败', 500);

$temporary = $path . '.tmp';
$apiHeaderUrl = steamChineseHeaderUrl($appId);
$legacyChineseUrl = 'https://cdn.akamai.steamstatic.com/steam/apps/' . $appId . '/header_schinese.jpg';
$defaultUrl = 'https://cdn.akamai.steamstatic.com/steam/apps/' . $appId . '/header.jpg';
if (!($trustedSourceUrl && downloadSteamHeader($trustedSourceUrl, $temporary))
    && !($apiHeaderUrl && downloadSteamHeader($apiHeaderUrl, $temporary))
    && !downloadSteamHeader($legacyChineseUrl, $temporary)
    && !downloadSteamHeader($defaultUrl, $temporary)) {
    fail('Steam 头图下载失败', 502);
}
if (!rename($temporary, $path)) {
    @unlink($temporary);
    fail('保存 Steam 头图失败', 500);
}
chmod($path, 0644);
echo json_encode(['url' => 'https://palewinds.com/media/game-covers/' . $filename], JSON_UNESCAPED_UNICODE);