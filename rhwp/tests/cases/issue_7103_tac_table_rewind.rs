//! [#7103 / #7096] 구조 제어 사이의 TAC 표는 실제 저장 줄의 위치를 사용한다.
//! 한컴 기준: pdf/ari-tutoring-application-2020.pdf (engine 2020).
//! 단순 비겹침뿐 아니라 표 경계와 양수/음수 저장 간격을 독립 검증한다.

#![cfg(not(target_arch = "wasm32"))]

use std::path::Path;

use rhwp::document_core::DocumentCore;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};

const SAMPLE: &str = "tests/fixtures/issue_7103/ari-tutoring-application.hwp";
const PAGE: u32 = 0;
const HOST_PARA: usize = 0;
const TITLE_TABLE_CONTROL: usize = 3;
const CONSENT_TABLE_CONTROL: usize = 5;

#[derive(Clone, Copy, Debug)]
struct TableBox {
    control_index: usize,
    y: f64,
    bottom: f64,
}

fn load() -> DocumentCore {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE);
    DocumentCore::from_bytes(&std::fs::read(&path).expect("read #7103 fixture"))
        .unwrap_or_else(|error| panic!("open {}: {error}", path.display()))
}

fn collect_host_tables(node: &RenderNode, in_column: bool, out: &mut Vec<TableBox>) {
    if in_column {
        if let RenderNodeType::Table(table) = &node.node_type {
            if table.para_index == Some(HOST_PARA) {
                if let Some(control_index) = table.control_index {
                    if [TITLE_TABLE_CONTROL, CONSENT_TABLE_CONTROL].contains(&control_index) {
                        out.push(TableBox {
                            control_index,
                            y: node.bbox.y,
                            bottom: node.bbox.y + node.bbox.height,
                        });
                    }
                }
            }
            return;
        }
    }

    let in_column = in_column || matches!(node.node_type, RenderNodeType::Column(_));
    for child in &node.children {
        collect_host_tables(child, in_column, out);
    }
}

#[test]
fn consecutive_tac_tables_do_not_rewind_to_the_previous_line_segment() {
    let core = load();
    let page = core
        .build_page_render_tree(PAGE)
        .expect("render #7103 page 1");
    let mut tables = Vec::new();
    collect_host_tables(&page.root, false, &mut tables);
    tables.sort_by(|a, b| a.control_index.cmp(&b.control_index));

    let title = tables
        .iter()
        .find(|table| table.control_index == TITLE_TABLE_CONTROL)
        .unwrap_or_else(|| {
            panic!("제목 TAC 표(ci={TITLE_TABLE_CONTROL})를 찾을 수 없음: {tables:?}")
        });
    let consent = tables
        .iter()
        .find(|table| table.control_index == CONSENT_TABLE_CONTROL)
        .unwrap_or_else(|| {
            panic!("개인정보 TAC 표(ci={CONSENT_TABLE_CONTROL})를 찾을 수 없음: {tables:?}")
        });

    assert!(
        consent.y + 0.5 >= title.bottom,
        "#7103: 둘째 TAC 표는 제목 표 아래에서 시작해야 한다. \
         title={title:?}, consent={consent:?}"
    );
    // 한컴 PDF의 제목 하단 띠 bottom=116.992pt. 근거 없는 2px gap 상한은 제거한다.
    assert!(
        (title.bottom - 116.992 * 96.0 / 72.0).abs() < 0.5,
        "제목 하단 {title:?}"
    );
}

fn all_nodes<'a>(node: &'a RenderNode, out: &mut Vec<&'a RenderNode>) {
    out.push(node);
    for child in &node.children {
        all_nodes(child, out);
    }
}

#[test]
fn hancom_privacy_and_tutor_boundaries_match() {
    let core = load();
    assert_eq!(core.page_count(), 1);
    let page = core.build_page_render_tree(0).unwrap();
    let mut nodes = Vec::new();
    all_nodes(&page.root, &mut nodes);
    let privacy = nodes.iter().find(|n| matches!(&n.node_type, RenderNodeType::Table(t) if t.row_count == 2 && t.col_count == 3)).unwrap();
    let body = nodes.iter().find(|n| matches!(&n.node_type, RenderNodeType::Table(t) if t.para_index == Some(0) && t.control_index == Some(5))).unwrap();
    let tutor = body
        .children
        .iter()
        .find(|n| matches!(&n.node_type, RenderNodeType::TableCell(c) if c.row == 1 && c.col == 0))
        .unwrap();
    // PDF의 독립 수평 경계. 글자 bbox나 글꼴 모양과 비교하지 않는다.
    for (actual, pdf_pt) in [(privacy.bbox.y, 151.994), (tutor.bbox.y, 286.487)] {
        assert!(
            (actual - pdf_pt * 96.0 / 72.0).abs() < 0.5,
            "actual={actual}, Hancom={pdf_pt}pt"
        );
    }
}

fn stored_gap_survives(gap: i32) {
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(SAMPLE)).unwrap();
    let mut doc = rhwp::parser::parse_document(&bytes).unwrap();
    let para = &mut doc.sections[0].paragraphs[0];
    // 원시 24/40은 두 표의 위치이며 header/footer의 원래 순서는 유지한다.
    let delta = para.line_segs[1].line_height + gap;
    para.line_segs[3].vertical_pos = para.line_segs[1].vertical_pos + delta;
    let bytes = rhwp::serializer::serialize_document(&doc).unwrap();
    let core = DocumentCore::from_bytes(&bytes).unwrap();
    let page = core.build_page_render_tree(0).unwrap();
    let mut tables = Vec::new();
    collect_host_tables(&page.root, false, &mut tables);
    tables.sort_by_key(|table| table.control_index);
    assert_eq!(tables.len(), 2);
    let actual = tables[1].y - tables[0].y;
    assert!(
        (actual - f64::from(delta) / 75.0).abs() < 0.1,
        "stored gap={gap}: {tables:?}"
    );
}

#[test]
fn positive_saved_gap_is_preserved() {
    stored_gap_survives(600);
}

#[test]
fn negative_saved_gap_is_not_clamped() {
    stored_gap_survives(-100);
}
