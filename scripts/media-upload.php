<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Authorization, Content-Type');
header('Access-Control-Allow-Methods: POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

function fail($message, $status = 400) {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('仅支持 POST 请求', 405);
$token = preg_replace('/^Bearer\s+/i', '', $_SERVER['HTTP_AUTHORIZATION'] ?? '');
if (!$token || !preg_match('/^[a-f0-9]{64}$/', $token)) fail('未授权', 401);
$kind = $_POST['kind'] ?? '';
$limits = ['avatar' => 512 * 1024, 'cover' => 800 * 1024];
if (!isset($limits[$kind])) fail('无效的图片类型');
if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) fail('未收到图片文件');
$file = $_FILES['file'];
if ($file['size'] < 1 || $file['size'] > $limits[$kind]) fail('图片体积超出限制');

$config = parse_ini_file(__DIR__ . '/runtime/keyflow-media.ini');
if (!$config || empty($config['SUPABASE_URL']) || empty($config['SUPABASE_ANON_KEY'])) fail('服务配置缺失', 500);
$payload = json_encode(['p_token' => $token]);
$curl = curl_init(rtrim($config['SUPABASE_URL'], '/') . '/rest/v1/rpc/keyflow_validate_media_upload_token');
curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => [
        'apikey: ' . $config['SUPABASE_ANON_KEY'],
        'Authorization: Bearer ' . $config['SUPABASE_ANON_KEY'],
        'Content-Type: application/json',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
]);
$response = curl_exec($curl);
$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);
$answererId = json_decode($response, true);
if ($status !== 200 || !is_string($answererId) || !preg_match('/^[a-f0-9-]{36}$/', $answererId)) fail('登录状态已失效，请重新登录', 401);

$imageInfo = @getimagesize($file['tmp_name']);
$mime = $imageInfo['mime'] ?? '';
$extensions = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
if (!isset($extensions[$mime])) fail('仅支持 JPG、PNG 或 WebP 图片');
$directory = '/www/wwwroot/39.96.61.144/AutokeyProject/media/' . $kind . 's';
if (!is_dir($directory) && !mkdir($directory, 0755, true)) fail('创建媒体目录失败', 500);
$filename = $answererId . '-' . bin2hex(random_bytes(8)) . '.' . $extensions[$mime];
$path = $directory . '/' . $filename;
if (!move_uploaded_file($file['tmp_name'], $path)) fail('保存图片失败', 500);

// 看板头图仅保留该答主最后一次上传的文件。
if ($kind === 'cover') {
    foreach (glob($directory . '/' . $answererId . '-*') ?: [] as $oldPath) {
        if ($oldPath !== $path) @unlink($oldPath);
    }
}
echo json_encode(['url' => 'https://palewinds.com/media/' . $kind . 's/' . $filename], JSON_UNESCAPED_UNICODE);