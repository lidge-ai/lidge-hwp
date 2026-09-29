// 테스트용 슬라이드: 평면 XML ODP(fodp)를 LibreOffice로 pptx·odp로 바꾼다(바이너리 픽스처를 커밋하지 않는다).
import { convert } from '../../lib/office/soffice.mjs';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function flatOdp(titles) {
  const pages = titles.map((title, i) => '<draw:page draw:name="p' + (i + 1) + '" draw:master-page-name="Default"><draw:frame draw:style-name="t" svg:x="2cm" svg:y="3cm" svg:width="24cm" svg:height="4cm"><draw:text-box><text:p text:style-name="big">' + esc(title) + '</text:p></draw:text-box></draw:frame></draw:page>').join('');
  const styles = '<office:automatic-styles><style:style style:name="t" style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/></style:style><style:style style:name="big" style:family="paragraph"><style:text-properties fo:font-size="40pt" fo:color="#17191d" style:font-name-asian="Apple SD Gothic Neo"/></style:style></office:automatic-styles>';
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">' + styles + '<office:master-styles><style:master-page style:name="Default"/></office:master-styles><office:body><office:presentation>' + pages + '</office:presentation></office:body></office:document>');
}
export const slidesAs = (titles, to) => convert(flatOdp(titles), { from: 'fodp', to });
