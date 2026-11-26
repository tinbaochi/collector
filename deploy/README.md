# Cấu hình cho bộ thu thập trên mây (GitHub Actions → GitHub Pages)

Trang https://tinbaochi.github.io/ hiển thị **dữ liệu thật**, thu thập tự động **mỗi giờ** bởi workflow `.github/workflows/pages.yml` (`scripts/cloud-collect.ts`).

- Mặc định dùng nguồn tin, từ khóa, quy tắc từ Skill gốc (giống bản local khi mới cài).
- Muốn bản web dùng đúng cấu hình bạn đã chỉnh ở bản local: mở **Cài đặt › Sao lưu & lịch sử › Tải bản sao lưu**, đổi tên tệp thành `deploy/config.json`, commit và push. Lần chạy kế tiếp sẽ dùng cấu hình đó.
- Dữ liệu công khai chỉ gồm: tiêu đề, link bài gốc, sapo ≤ 300 ký tự, giờ đăng, phân loại gợi ý, sổ ứng viên (lý do lọc), độ phủ, sức khỏe bộ bóc tách. **Không** đăng toàn văn bài, **không** đăng/hotlink ảnh của báo.
- Mẫu PPTX của Sở **không** được đưa lên; báo cáo theo mẫu chỉ xuất ở bản local.
- Lưu ý GitHub: lịch chạy có thể trễ vài phút; GitHub tự tắt lịch của repo không có hoạt động (commit) trong 60 ngày – khi đó vào tab Actions bật lại.
- Một số báo có thể chặn IP máy chủ GitHub; trạng thái từng báo hiện trong tab **Độ phủ & nguồn**.
