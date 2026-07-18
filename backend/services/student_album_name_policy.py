"""學生相本稱呼的自動推導與同專案碰撞規則。"""

from collections import Counter
from collections.abc import Collection, Sequence


# 複姓只用來阻止不可靠的自動拆分，不把字典當成姓名真相來源。
KNOWN_COMPOUND_SURNAMES = frozenset({
    "歐陽", "司馬", "上官", "諸葛", "夏侯", "東方", "皇甫", "尉遲",
    "公孫", "慕容", "司徒", "司空", "令狐", "宇文", "長孫", "南宮",
    "獨孤", "軒轅", "鍾離", "端木", "拓跋", "百里", "東郭", "西門",
    "呼延", "羊舌", "微生", "梁丘", "左丘", "公羊", "公冶", "公良",
})


def is_han_character(character: str) -> bool:
    """辨識姓名規則接受的 CJK 漢字範圍。"""
    codepoint = ord(character)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def suggest_automatic_album_name(full_name: str) -> str | None:
    """只為一般二至三字純漢字姓名移除首字；不確定時不自動設定。"""
    normalized_name = full_name.strip()
    if len(normalized_name) not in {2, 3}:
        return None
    if not all(is_han_character(character) for character in normalized_name):
        return None
    if normalized_name[:2] in KNOWN_COMPOUND_SURNAMES:
        return None
    return normalized_name[1:]


def assign_automatic_album_names(
    full_names: Sequence[str],
    existing_effective_album_names: Collection[str],
) -> list[str | None]:
    """批次推導相本稱呼；反覆撤回碰撞候選，直到所有 effective 名稱穩定。"""
    candidates = [suggest_automatic_album_name(full_name) for full_name in full_names]
    normalized_full_names = [full_name.strip() for full_name in full_names]
    existing_names = [
        effective_name.strip()
        for effective_name in existing_effective_album_names
        if effective_name.strip()
    ]
    active_candidates = [candidate is not None for candidate in candidates]

    while True:
        effective_names = [
            candidate if is_active else full_name
            for candidate, full_name, is_active in zip(
                candidates,
                normalized_full_names,
                active_candidates,
                strict=True,
            )
        ]
        effective_counts = Counter([*existing_names, *effective_names])
        colliding_indices = [
            index
            for index, (effective_name, is_active) in enumerate(
                zip(effective_names, active_candidates, strict=True)
            )
            if is_active and effective_counts[effective_name] > 1
        ]
        if not colliding_indices:
            break
        for index in colliding_indices:
            active_candidates[index] = False

    return [
        candidate if is_active else None
        for candidate, is_active in zip(candidates, active_candidates, strict=True)
    ]
