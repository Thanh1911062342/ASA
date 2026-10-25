# ffmpeg.wasm core — self-hosted

Hai file ở đây là bản **esm** của `@ffmpeg/core@0.12.10`, tải từ
`https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/`.

## Vì sao self-host mà không dùng CDN

CDN không chạy được, dù jsdelivr gửi `Access-Control-Allow-Origin: *` và file
tải về bình thường khi thử riêng lẻ:

`@ffmpeg/ffmpeg` luôn tạo worker với `{ type: "module" }`. Trong worker module,
`importScripts()` **tồn tại nhưng gọi vào thì ném lỗi** — "Module scripts don't
support importScripts()". Điều đó loại bỏ bản core **umd**, vốn chỉ nạp được
bằng `importScripts`. Bản **esm** là thứ worker của thư viện nạp được, bằng
`import()` động.

URL truyền cho `load()` phải là **tuyệt đối** (`lib/ytdownload.ts` dùng
`coreUrl()` để resolve theo `location.origin`): worker được tạo từ blob URL nên
không có base ý nghĩa, và một đường dẫn gốc-tương-đối như `/ffmpeg/x.js` sẽ bị
báo "The URL is invalid".

Cả hai điều trên chỉ hiện ra dưới dạng một thông báo rất khó đoán:
`failed to import ffmpeg-core.js`.

## Vì sao commit thẳng file 32 MB vào repo

Vercel build từ repo này, và `public/` được copy nguyên vào bản deploy — không
có bước tải nào khác. Bỏ hai file này đi thì tính năng "tải YouTube về máy"
hỏng ngay lúc chạy, không phải lúc build.

Đây là đánh đổi có ý thức: 32 MB trong repo, đổi lấy việc core luôn sẵn sàng
cùng origin và không phụ thuộc bên thứ ba. Hai file này **chỉ được tải khi
người dùng thực sự bấm "Tải về máy"** (32 MB đó không nằm trong bundle chính).

## Nâng cấp

Đổi `CORE_VERSION` tương ứng trong `src/lib/ytdownload.ts` rồi tải lại:

```bash
cd frontend
V=0.12.10
curl -sL -o public/ffmpeg/ffmpeg-core.js   "https://cdn.jsdelivr.net/npm/@ffmpeg/core@$V/dist/esm/ffmpeg-core.js"
curl -sL -o public/ffmpeg/ffmpeg-core.wasm "https://cdn.jsdelivr.net/npm/@ffmpeg/core@$V/dist/esm/ffmpeg-core.wasm"
```

Nhớ dùng `/esm/`, không phải `/umd/`.