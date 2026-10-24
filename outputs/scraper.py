#!/usr/bin/env python3
"""Thai-job search adapter for the JobThai Radar demo.

The public mobile pages of 职友集 aggregate listings from multiple Chinese
recruitment platforms. This adapter intentionally uses only the standard
library so the app can run on a clean macOS installation.
"""

from __future__ import annotations

import html
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple


SALARY_FLOOR = 8000
SITE_ROOT = "https://m.jobui.com"
CHINA_TZ = timezone(timedelta(hours=8))

SOURCES = (
    {
        "id": "national",
        "label": "全国",
        "url": f"{SITE_ROOT}/jobs/l-quanguo-q-taiyufanyi/",
    },
    {
        "id": "xian",
        "label": "西安",
        "url": f"{SITE_ROOT}/jobs/l-xian-q-taiyufanyi/",
    },
    {
        "id": "kunming",
        "label": "昆明",
        "url": f"{SITE_ROOT}/jobs/l-kunming-q-taiyufanyi/",
    },
)

USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 Mobile/15E148"
)


@dataclass
class Job:
    id: str
    title: str
    company: str
    salary_text: str
    salary_min: Optional[int]
    salary_max: Optional[int]
    city: str
    city_priority: int
    location: str
    experience: str
    degree: str
    published_text: str
    published_at: Optional[str]
    age_days: Optional[int]
    freshness: str
    freshness_label: str
    source: str
    source_url: str
    apply_method: str
    apply_steps: List[str]
    industry: str
    company_size: str
    company_views: str
    description: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value or "")
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def attr_value(block: str, attr: str, *, last: bool = False) -> str:
    pattern = rf'\b{re.escape(attr)}="([^"]*)"'
    values = re.findall(pattern, block, flags=re.I | re.S)
    if not values:
        return ""
    return html.unescape(values[-1] if last else values[0])


def single_match(pattern: str, block: str, flags: int = 0) -> str:
    match = re.search(pattern, block, flags=flags | re.I | re.S)
    return clean_text(match.group(1)) if match else ""


def fetch_url(url: str, retries: int = 2, timeout: int = 25) -> str:
    """Fetch a public listing page, with small retries for transient 502s."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        },
    )
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                text = body.decode(charset, errors="replace")
                if "验证码验证" in text or "Security Verification" in text:
                    raise RuntimeError("招聘站触发人工验证")
                if "<html" not in text.lower():
                    raise RuntimeError("招聘站返回了无效页面")
                return text
        except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(1.4 * (attempt + 1))
    raise RuntimeError(str(last_error or "抓取失败"))


def parse_salary(text: str) -> Tuple[Optional[int], Optional[int]]:
    """Parse a Chinese monthly salary range into integer RMB values."""
    if not text or any(word in text for word in ("面议", "不限", "元/时", "元/天")):
        return None, None

    range_match = re.search(
        r"(\d+(?:\.\d+)?)\s*(万|千|k|K|元)?\s*[-~至]\s*"
        r"(\d+(?:\.\d+)?)\s*(万|千|k|K|元)?",
        text,
    )
    if not range_match:
        single = re.search(r"(\d+(?:\.\d+)?)\s*(万|千|k|K|元)", text)
        if not single:
            return None, None
        value = _salary_value(single.group(1), single.group(2))
        return value, value

    first, first_unit, second, second_unit = range_match.groups()
    unit = second_unit or first_unit or ""
    first_value = _salary_value(first, first_unit or unit)
    second_value = _salary_value(second, second_unit or unit)
    if first_unit and not second_unit:
        second_value = _salary_value(second, first_unit)
    if second_unit and not first_unit:
        first_value = _salary_value(first, second_unit)
    if first_value > second_value:
        first_value, second_value = second_value, first_value
    return first_value, second_value


def _salary_value(number: str, unit: str) -> int:
    value = float(number)
    unit = unit.lower()
    if unit == "万":
        value *= 10000
    elif unit in ("千", "k"):
        value *= 1000
    return int(round(value))


def parse_published(value: str, scraped_at: datetime) -> Tuple[Optional[str], Optional[int]]:
    value = value.strip()
    if not value:
        return None, None

    full_date = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", value)
    if full_date:
        try:
            parsed = date(*map(int, full_date.groups()))
            return parsed.isoformat(), max(0, (scraped_at.date() - parsed).days)
        except ValueError:
            return None, None

    if value in ("今天", "刚刚"):
        return scraped_at.date().isoformat(), 0
    if value == "昨天":
        parsed = scraped_at.date() - timedelta(days=1)
        return parsed.isoformat(), 1

    relative = re.search(r"(\d+)\s*天前", value)
    if relative:
        days = int(relative.group(1))
        return (scraped_at.date() - timedelta(days=days)).isoformat(), days
    relative = re.search(r"(\d+)\s*(小时|分钟)前", value)
    if relative:
        return scraped_at.date().isoformat(), 0
    return None, None


def infer_city(title: str, location: str) -> Tuple[str, int]:
    haystack = f"{title} {location}"
    if "西安" in haystack:
        return "西安", 1
    if "昆明" in haystack:
        return "昆明", 1
    if any(place in haystack for place in ("泰国", "曼谷", "春武里", "罗勇", "巴真")):
        return "海外 · 泰国", 3

    title_place = re.search(r"[（(]([^）)]+)[）)]", title)
    if title_place:
        place = title_place.group(1).split("-")[0].strip()
        if any(word in place for word in ("越南", "老挝", "柬埔寨", "缅甸")):
            return f"海外 · {place}", 3
        if place:
            return place, 2

    cleaned = location.split("省")[-1]
    city_match = re.match(r"([\u4e00-\u9fa5]{2,8}?)(?:市|区|县|-)", cleaned)
    return (city_match.group(1) if city_match else "地点待确认"), 2


def parse_job_block(
    block: str,
    source_label: str,
    scraped_at: datetime,
) -> Optional[Job]:
    position_id = attr_value(block, "data-positionID")
    raw_title = attr_value(block, "title")
    title = single_match(r'<h3[^>]*class="[^"]*job-name[^"]*"[^>]*>(.*?)</h3>', block)
    if not position_id or not title:
        return None
    if "泰语" not in title and "thai" not in title.lower():
        return None

    salary_text = attr_value(block, "title") if "工资：" in attr_value(block, "title") else ""
    salary_match = re.search(r'<span[^>]*title="工资：([^"]+)"', block, flags=re.I | re.S)
    if salary_match:
        salary_text = html.unescape(salary_match.group(1)).strip()
    if not salary_text:
        salary_text = single_match(
            r'<span[^>]*class="[^"]*f60[^"]*"[^>]*>(.*?)</span>', block
        )

    experience = ""
    degree = ""
    experience_match = re.search(
        r'title="工作经验要求：([^"]+)"', block, flags=re.I | re.S
    )
    degree_match = re.search(r'title="学历要求：([^"]+)"', block, flags=re.I | re.S)
    if experience_match:
        experience = html.unescape(experience_match.group(1)).strip()
    if degree_match:
        degree = html.unescape(degree_match.group(1)).strip()

    published_text = single_match(
        r'<div class="gray9">\s*((?:\d{4}-\d{1,2}-\d{1,2})|(?:\d+\s*天前)|(?:今天|昨天|刚刚))\s*</div>',
        block,
    )
    published_at, age_days = parse_published(published_text, scraped_at)

    long_names = [
        clean_text(item)
        for item in re.findall(
            r'<div class="[^"]*gray9[^"]*long-name[^"]*"[^>]*>(.*?)</div>',
            block,
            flags=re.I | re.S,
        )
    ]
    company = single_match(
        r'<span class="company-name"[^>]*>(.*?)</span>', block
    ) or clean_text(raw_title.split("招聘")[0])
    if not company:
        company = "公司名称待确认"

    location = ""
    for candidate in long_names:
        if candidate and candidate != company and not re.match(
            r"^\d+(?:\.\d+)?万?次", candidate
        ):
            location = candidate
            break

    industry = ""
    company_size = ""
    company_views = ""
    comments = [
        clean_text(item)
        for item in re.findall(
            r'<span class="comment-text">(.*?)</span>', block, flags=re.I | re.S
        )
    ]
    for item in comments:
        if "次浏览" in item:
            company_views = item.replace("/", "").strip()
        elif "/" in item and not industry:
            industry = item.replace("/", "").strip()
        elif "/" in item and not company_size:
            company_size = item.replace("/", "").strip()
        elif not industry and item:
            industry = item.replace("/", "").strip()
        elif not company_size and item:
            company_size = item.replace("/", "").strip()

    city, priority = infer_city(raw_title or title, location)
    salary_min, salary_max = parse_salary(salary_text)
    source_url = f"{SITE_ROOT}/job/{position_id}/"

    if age_days is None:
        freshness = "verify"
        freshness_label = "页面可见 · 建议确认"
    elif age_days <= 30:
        freshness = "recent"
        freshness_label = "近期可投递 · 待平台确认"
    else:
        freshness = "verify"
        freshness_label = f"{age_days} 天前更新 · 建议确认"

    return Job(
        id=position_id,
        title=title,
        company=company,
        salary_text=salary_text or "面议",
        salary_min=salary_min,
        salary_max=salary_max,
        city=city,
        city_priority=priority,
        location=location or city,
        experience=experience or "经验不限",
        degree=degree or "学历未标明",
        published_text=published_text or "更新时间未标明",
        published_at=published_at,
        age_days=age_days,
        freshness=freshness,
        freshness_label=freshness_label,
        source=f"{source_label} · 职友集聚合",
        source_url=source_url,
        apply_method="进入职位页，登录后在线申请或与招聘方沟通",
        apply_steps=[
            "打开职位详情，确认岗位仍在招聘",
            "登录原招聘平台并上传或发送简历",
            "使用平台内的“立即申请 / 沟通”入口联系招聘方",
        ],
        industry=industry or "行业未标明",
        company_size=company_size or "规模未标明",
        company_views=company_views,
        description=f"{experience or '经验不限'} · {degree or '学历未标明'}",
    )


def parse_search_page(
    text: str,
    source_label: str,
    scraped_at: Optional[datetime] = None,
) -> List[Job]:
    scraped_at = scraped_at or datetime.now(CHINA_TZ)
    blocks = re.findall(
        r'<li class="jobui-container job-search-list">(.*?)</li>\s*(?=<li|</ul>)',
        text,
        flags=re.I | re.S,
    )
    jobs: List[Job] = []
    for block in blocks:
        job = parse_job_block(block, source_label, scraped_at)
        if job:
            jobs.append(job)
    return jobs


def deduplicate(jobs: Iterable[Job]) -> List[Job]:
    by_id: Dict[str, Job] = {}
    for job in jobs:
        previous = by_id.get(job.id)
        # Prefer the city-targeted result when the same listing appears twice.
        if previous is None or (job.city_priority, -len(job.source)) < (
            previous.city_priority,
            -len(previous.source),
        ):
            by_id[job.id] = job
    return list(by_id.values())


def sort_jobs(jobs: Iterable[Job]) -> List[Job]:
    return sorted(
        jobs,
        key=lambda job: (
            job.city_priority,
            0 if job.freshness == "recent" else 1,
            -(job.salary_max or job.salary_min or 0),
            job.age_days if job.age_days is not None else 999,
            job.company,
        ),
    )


def scrape_source(source: Dict[str, str], now: datetime) -> Tuple[str, List[Job], Optional[str]]:
    try:
        text = fetch_url(source["url"], retries=1)
        jobs = parse_search_page(text, source["label"], now)
        if not jobs and 'data-hasJob="1"' in text:
            return source["id"], [], "页面结构发生变化"
        return source["id"], jobs, None
    except Exception as exc:  # keep other sources usable
        return source["id"], [], str(exc)


def scrape_all(previous: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    now = datetime.now(CHINA_TZ)
    source_status: List[Dict[str, Any]] = []
    collected: List[Job] = []

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(scrape_source, source, now): source for source in SOURCES
        }
        for future in as_completed(futures):
            source = futures[future]
            source_id, jobs, error = future.result()
            source_status.append(
                {
                    "id": source_id,
                    "label": source["label"],
                    "ok": error is None,
                    "found": len(jobs),
                    "error": error,
                }
            )
            collected.extend(jobs)

    unique = deduplicate(collected)
    matched = [
        job
        for job in unique
        if job.salary_min is not None and job.salary_min >= SALARY_FLOOR
    ]

    # A transient failure must not erase a usable cached result set.
    if not matched and previous and previous.get("jobs"):
        old_jobs = previous["jobs"]
        meta = dict(previous.get("meta", {}))
        meta.update(
            {
                "last_attempt": now.isoformat(),
                "status": "degraded",
                "message": "本次抓取未获得新结果，已继续展示上次有效数据",
                "source_status": sorted(source_status, key=lambda item: item["id"]),
            }
        )
        meta.setdefault("last_success", now.isoformat())
        return {"jobs": old_jobs, "meta": meta}

    jobs = [job.to_dict() for job in sort_jobs(matched)]
    priority_count = sum(1 for job in jobs if job["city_priority"] == 1)
    recent_count = sum(1 for job in jobs if job["freshness"] == "recent")
    status = "ok" if any(item["ok"] for item in source_status) else "degraded"
    message = (
        f"已检索 {len(unique)} 个泰语岗位，筛出 {len(jobs)} 个月薪不低于 8,000 元的岗位"
        if status == "ok"
        else "招聘站暂时限流，已保留上次有效结果"
    )

    return {
        "jobs": jobs,
        "meta": {
            "last_attempt": now.isoformat(),
            "last_success": now.isoformat() if status == "ok" else None,
            "status": status,
            "message": message,
            "total_seen": len(unique),
            "matched": len(jobs),
            "priority_count": priority_count,
            "recent_count": recent_count,
            "salary_floor": SALARY_FLOOR,
            "source_status": sorted(source_status, key=lambda item: item["id"]),
        },
    }


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    if len(sys.argv) == 3 and sys.argv[1] == "--output":
        output_path = Path(sys.argv[2])
        previous = None
        if output_path.exists():
            try:
                previous = json.loads(output_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                previous = None
        result = scrape_all(previous)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(result["meta"]["message"])
        print(f"Saved to {output_path}")
    elif len(sys.argv) == 2 and sys.argv[1] == "--stdin":
        payload = json.load(sys.stdin)
        print(json.dumps(scrape_all(payload), ensure_ascii=False, indent=2))
    elif len(sys.argv) == 2:
        source = next(
            (item for item in SOURCES if item["id"] == sys.argv[1]),
            None,
        )
        if source:
            print(json.dumps(scrape_all(), ensure_ascii=False, indent=2))
        else:
            print(f"Unknown source: {sys.argv[1]}", file=sys.stderr)
            raise SystemExit(2)
    else:
        print(json.dumps(scrape_all(), ensure_ascii=False, indent=2))
