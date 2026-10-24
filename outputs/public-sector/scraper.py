#!/usr/bin/env python3
"""Refresh the public-sector position snapshot from a public exam index.

The source is a searchable mirror of the national civil-service position table.
The final application must always be completed on the official government site.
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


SOURCE_ROOT = "https://tt.huatu.com/zw"
DETAIL_ROOT = "https://ah.huatu.com/zw"
OFFICIAL_URL = "http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/auth/login.html"
YEAR = "2027"
CHINA_TZ = timezone(timedelta(hours=8))
REGISTRATION_OPEN = "2026-10-15T08:00:00+08:00"
REGISTRATION_DEADLINE = "2026-10-24T18:00:00+08:00"
EXAM_AT = "2026-11-29T09:00:00+08:00"

PROVINCES = (
    "anhui", "beijing", "chongqing", "fujian", "gansu", "guangdong",
    "guangxi", "guizhou", "hainan", "hebei", "heilongjiang", "henan",
    "hubei", "hunan", "jiangsu", "jiangxi", "jilin", "liaoning",
    "neimenggu", "ningxia", "qinghai", "shandong", "shanghai", "shanxi",
    "shanxisheng", "sichuan", "tianjin", "xicang", "xinjiang", "yunnan",
    "zhejiang",
)

MONITORS = [
    {
        "id": "yunnan-institution",
        "name": "云南事业单位",
        "category": "事业单位",
        "status": "已监测",
        "latest": "今日未发现直接匹配的开放岗位",
        "sourceName": "云南省人社厅事业单位招聘",
        "url": "https://hrss.yn.gov.cn/NewsLsit.aspx?ClassID=602",
    },
    {
        "id": "kunming-institution",
        "name": "昆明事业单位",
        "category": "事业单位",
        "status": "已监测",
        "latest": "以市级及区县招聘公告为准",
        "sourceName": "昆明市人力资源和社会保障局",
        "url": "https://rsj.km.gov.cn/",
    },
    {
        "id": "xian-institution",
        "name": "西安事业单位",
        "category": "事业单位",
        "status": "已监测",
        "latest": "当前未发现专业直接匹配岗位",
        "sourceName": "西安市人力资源和社会保障局",
        "url": "https://xahrss.xa.gov.cn/",
    },
    {
        "id": "yunnan-civil",
        "name": "云南省公务员 / 参公",
        "category": "公务员 / 参公",
        "status": "等待公告",
        "latest": "2027 省考尚未进入报名阶段",
        "sourceName": "云南省人社厅招考招聘",
        "url": "https://hrss.yn.gov.cn/NewsLsit.aspx?ClassID=458",
    },
    {
        "id": "shaanxi-civil",
        "name": "陕西省公务员 / 参公",
        "category": "公务员 / 参公",
        "status": "等待公告",
        "latest": "2027 省考尚未进入报名阶段",
        "sourceName": "陕西省人事考试网",
        "url": "http://www.sxrsks.cn/",
    },
]


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value or "")
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def fetch(url: str, timeout: int = 30, retries: int = 1) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(1)
    raise RuntimeError(str(last_error or "fetch failed"))


def parse_province_cities(slug: str) -> List[Tuple[str, str]]:
    url = f"{SOURCE_ROOT}/{slug}/"
    text = fetch(url)
    block_match = re.search(r"<div class='xianqu'>(.*?)</div>", text, re.S)
    if not block_match:
        return []
    cities: List[Tuple[str, str]] = []
    for href, raw_name in re.findall(
        r"<a[^>]*href='([^']+)'[^>]*>(.*?)</a>",
        block_match.group(1),
        re.S,
    ):
        name = clean_text(raw_name)
        if name:
            cities.append((name, urllib.parse.urljoin(url, href)))
    return cities


def is_thai_relevant(major: str) -> bool:
    if "泰语" in major:
        return True
    if "亚非语言文学" not in major:
        return False
    non_thai = ("越南语方向", "朝鲜语方向", "缅甸语方向", "老挝语方向")
    return not any(label in major for label in non_thai)


def parse_city(slug: str, city_name: str, url: str) -> List[Dict[str, Any]]:
    text = fetch(url)
    matches: List[Dict[str, Any]] = []
    for row in re.findall(r"<tr class='list_one'>(.*?)</tr>", text, re.S):
        cells = [
            clean_text(cell)
            for cell in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        ]
        if len(cells) < 9:
            continue
        major = cells[5]
        education = cells[4]
        if "本科" not in education or not is_thai_relevant(major):
            continue
        detail_match = re.search(r"href='([^']+)'", row)
        matches.append(
            {
                "provinceSlug": slug,
                "city": city_name,
                "code": cells[0],
                "employer": cells[1],
                "department": cells[2],
                "title": cells[3],
                "education": education,
                "majors": major,
                "openings": to_int(cells[6]),
                "applicants": to_int(cells[7]),
                "approved": to_int(cells[8]),
                "detailUrl": detail_match.group(1) if detail_match else "",
            }
        )
    return matches


def to_int(value: str) -> int:
    match = re.search(r"\d+", value)
    return int(match.group(0)) if match else 0


def parse_detail(item: Dict[str, Any]) -> Dict[str, Any]:
    text = fetch(item["detailUrl"])
    pairs = re.findall(
        r'<tr><td class="tbtt">(.*?)</td><td[^>]*>(.*?)</td></tr>',
        text,
        re.S,
    )
    fields = {clean_text(key): clean_text(value) for key, value in pairs}
    location = fields.get("工作地点") or item["city"]
    priority = 1 if "昆明市" in location or "西安市" in location else 2
    restrictions = []
    notes = fields.get("备注", "")
    for part in re.split(r"[；;。]\s*", notes):
        part = re.sub(r"^\d+[.．]\s*", "", part).strip()
        if part and len(part) <= 90:
            restrictions.append(part)
    if fields.get("政治面貌") and fields.get("政治面貌") != "不限":
        restrictions.append(f"政治面貌：{fields['政治面貌']}")
    if fields.get("基层工作最低年限") not in ("", "无限制"):
        restrictions.append(f"基层经历：{fields['基层工作最低年限']}")

    return {
        "id": f"gk-{YEAR}-{Path(urllib.parse.urlparse(item['detailUrl']).path).stem}",
        "category": "公务员",
        "exam": "国考",
        "title": fields.get("招考职位") or item["title"],
        "code": fields.get("职位代码") or item["code"],
        "department": fields.get("招录机关") or item["department"],
        "employer": fields.get("用人司局") or item["employer"],
        "province": fields.get("地区") or item["provinceSlug"],
        "city": city_from_location(location),
        "location": location,
        "openings": to_int(fields.get("招考人数", str(item["openings"]))),
        "applicants": to_int(fields.get("报名人数", str(item["applicants"]))),
        "approved": to_int(fields.get("合格人数", str(item["approved"]))),
        "education": fields.get("学历") or item["education"],
        "degree": fields.get("学位") or "未标明",
        "majors": fields.get("专业") or item["majors"],
        "political": fields.get("政治面貌") or "未标明",
        "experience": fields.get("基层工作最低年限") or "无限制",
        "freshGraduate": "应届" in notes,
        "gender": "女" if "限女性" in notes else "男" if "限男性" in notes else "不限",
        "examType": fields.get("考试类别") or "未标明",
        "deadline": REGISTRATION_DEADLINE,
        "status": "open",
        "priority": priority,
        "summary": fields.get("职位简介") or "",
        "restrictions": restrictions[:8],
        "detailUrl": item["detailUrl"],
        "officialUrl": OFFICIAL_URL,
        "contact": fields.get("咨询电话") or "见官方职位表",
        "applyMethod": "国家公务员考试专题网站在线提交报考申请",
        "source": f"{YEAR}国考职位表公开查询镜像",
    }


def city_from_location(location: str) -> str:
    if "昆明市" in location:
        return "昆明"
    if "西安市" in location:
        return "西安"
    match = re.search(r"省([\u4e00-\u9fa5]{2,6}?)(?:市|自治州)", location)
    if match:
        return match.group(1)
    match = re.search(r"自治区([\u4e00-\u9fa5]{2,8}?)(?:市|自治州)", location)
    if match:
        return match.group(1)
    return location.replace("省", "").replace("市", "")[:12]


def load_existing(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8")
        payload = text.split("=", 1)[1].strip().rstrip(";")
        return json.loads(payload)
    except (OSError, json.JSONDecodeError, IndexError):
        return None


def scrape() -> Dict[str, Any]:
    city_tasks: List[Tuple[str, str, str]] = []
    errors: List[str] = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(parse_province_cities, slug): slug for slug in PROVINCES}
        for future in as_completed(futures):
            slug = futures[future]
            try:
                for name, url in future.result():
                    city_tasks.append((slug, name, url))
            except Exception as exc:
                errors.append(f"{slug}: {exc}")

    raw_matches: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=14) as executor:
        futures = {
            executor.submit(parse_city, slug, city_name, url): city_name
            for slug, city_name, url in city_tasks
        }
        for future in as_completed(futures):
            city_name = futures[future]
            try:
                raw_matches.extend(future.result())
            except Exception as exc:
                errors.append(f"{city_name}: {exc}")

    unique = {item["code"]: item for item in raw_matches}
    jobs: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(parse_detail, item): item["code"]
            for item in unique.values()
        }
        for future in as_completed(futures):
            code = futures[future]
            try:
                jobs.append(future.result())
            except Exception as exc:
                errors.append(f"{code}: {exc}")

    jobs.sort(key=lambda job: (job["priority"], job["applicants"] / max(job["openings"], 1)))
    now = datetime.now(CHINA_TZ)
    return {
        "checkedAt": now.isoformat(),
        "registration": {
            "title": "2027年度国家公务员考试",
            "opensAt": REGISTRATION_OPEN,
            "deadline": REGISTRATION_DEADLINE,
            "examAt": EXAM_AT,
            "officialUrl": OFFICIAL_URL,
        },
        "jobs": jobs,
        "monitors": MONITORS,
        "scan": {
            "provincePages": len(PROVINCES),
            "cityPages": len(city_tasks),
            "professionalMatches": len(unique),
            "errors": errors[:12],
        },
    }


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "data.js")
    previous = load_existing(output)
    try:
        result = scrape()
        if not result["jobs"] and previous and previous.get("jobs"):
            previous["checkedAt"] = datetime.now(CHINA_TZ).isoformat()
            previous.setdefault("scan", {})["message"] = "本次未取得新职位，保留上次结果"
            result = previous
    except Exception as exc:
        if previous and previous.get("jobs"):
            previous["checkedAt"] = datetime.now(CHINA_TZ).isoformat()
            previous.setdefault("scan", {})["message"] = f"抓取失败，保留上次结果：{exc}"
            result = previous
        else:
            raise
    output.write_text(
        "window.PUBLIC_SECTOR_DATA = "
        + json.dumps(result, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    print(f"Saved {len(result.get('jobs', []))} positions to {output}")


if __name__ == "__main__":
    main()
