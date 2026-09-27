# 배포 글꼴의 저작권과 라이선스

확인일: 2026-09-27. 이 디렉터리는 `../*.woff2` 36개의 고지를 함께 배포하기 위한 자료다.
Source Han 옛한글 파생본은 아래 기록대로 내부 이름을 변경했다. 다른 35개 WOFF2는 기존 바이트를 유지한다.
프로젝트 MIT와 별개로 OFL/GUST 원문을 보존한다.

## 원문과 조사 범위

- 아래 텍스트와 PDF는 공식 공개 URL 또는 공식 ZIP member의 원본 바이트다. Happiness PDF는 기존 fixture의 사본이며 공식 ZIP과 동일함을 재확인했다.
- `OFL-1.1.txt`는 SIL 공식 배포 템플릿 원문이다. 꺾쇠 괄호 placeholder도 원문 그대로이며, 실제 권리자·파일별 고지는 아래 표와 개별 원문에 있다.
- [기계 판독 조사 기록](font-inventory.json)에 36개 파일의 현재 SHA-256, 길이, 내장 이름·저작권과 원문 URL·SHA-256을 기록했다. 변경된 파생본의 이전 값은 `preRename`에 보존한다. 내장 저작권과 별도 라이선스의 연도가 다르면 둘 다 보존한다.
- Cafe24 2개와 Happiness 4개는 공식 ZIP의 WOFF2 member와 바이트가 일치했다. 다른 글꼴의 원본 바이너리 동일성까지 검증한 것은 아니다.
- Studio의 `public/fonts -> ../../assets/fonts`를 통해 이 디렉터리도 배포한다. 별도 패키징에서도 `licenses/`를 누락하지 않는다.

## 파일별 고지

내장 저작권은 조사 당시 name ID 0의 원문이다. 이름 전체와 라이선스 설명/URL 필드는 JSON을 참조한다.

| 파일 | 내장 저작권 | 동봉 원문 | 프로젝트/출처 |
|---|---|---|---|
| [Cafe24Ssurround-v2.0.woff2](../Cafe24Ssurround-v2.0.woff2) | Copyright © Cafe24 Corp. All Rights Reserved. | [License-Ssurround.pdf](License-Ssurround.pdf), [OFL-1.1.txt](OFL-1.1.txt) | [출처](https://fonts.cafe24.com/) |
| [Cafe24Supermagic-Regular-v1.0.woff2](../Cafe24Supermagic-Regular-v1.0.woff2) | Copyright ⓒ Cafe24 Corp. All Rights Reserved. | [License-Supermagic.pdf](License-Supermagic.pdf), [OFL-1.1.txt](OFL-1.1.txt) | [출처](https://fonts.cafe24.com/) |
| [D2Coding-Bold.woff2](../D2Coding-Bold.woff2) | Copyright (c) 2015-2016 NHN Corporation. All rights reserved. Font designed by FONTRIX Inc. | [D2Coding-OFL.txt](D2Coding-OFL.txt) | [출처](https://github.com/naver/d2-coding-font) |
| [D2Coding-Regular.woff2](../D2Coding-Regular.woff2) | Copyright (c) 2015-2016 NHN Corporation. All rights reserved. Font designed by FONTRIX Inc. | [D2Coding-OFL.txt](D2Coding-OFL.txt) | [출처](https://github.com/naver/d2-coding-font) |
| [GowunBatang-Bold.woff2](../GowunBatang-Bold.woff2) | Copyright 2021 The Gowun Batang Project Authors (https://github.com/yangheeryu/Gowun-Batang) | [GowunBatang-OFL.txt](GowunBatang-OFL.txt) | [출처](https://github.com/yangheeryu/Gowun-Batang) |
| [GowunBatang-Regular.woff2](../GowunBatang-Regular.woff2) | Copyright 2021 The Gowun Batang Project Authors (https://github.com/yangheeryu/Gowun-Batang) | [GowunBatang-OFL.txt](GowunBatang-OFL.txt) | [출처](https://github.com/yangheeryu/Gowun-Batang) |
| [GowunDodum-Regular.woff2](../GowunDodum-Regular.woff2) | Copyright 2021 The Gowun Dodum Project Authors (https://github.com/yangheeryu/Gowun-Dodum) | [GowunDodum-OFL.txt](GowunDodum-OFL.txt) | [출처](https://github.com/yangheeryu/Gowun-Dodum) |
| [Happiness-Sans-Bold.woff2](../Happiness-Sans-Bold.woff2) | Copyright © 2022 by THE HYUNDAI. All right reserved. | [HapinessSans_License.pdf](HapinessSans_License.pdf) | [출처](https://thehyundaifont.com/) |
| [Happiness-Sans-Regular.woff2](../Happiness-Sans-Regular.woff2) | Copyright © 2022 by THE HYUNDAI. All right reserved. | [HapinessSans_License.pdf](HapinessSans_License.pdf) | [출처](https://thehyundaifont.com/) |
| [Happiness-Sans-Title.woff2](../Happiness-Sans-Title.woff2) | Copyright © 2022 by THE HYUNDAI. All right reserved. | [HapinessSans_License.pdf](HapinessSans_License.pdf) | [출처](https://thehyundaifont.com/) |
| [HappinessSansVF.woff2](../HappinessSansVF.woff2) | Copyright © 2022 by THE HYUNDAI. All right reserved. | [HapinessSans_License.pdf](HapinessSans_License.pdf) | [출처](https://thehyundaifont.com/) |
| [LatinModernMath-Regular.woff2](../LatinModernMath-Regular.woff2) | Copyright 2012--2014 for Latin Modern Math OTF by B. Jackowski, P. Strzelczyk and P. Pianowski (on behalf of TeX users groups). This work is released under the GUST Font License -- see http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt for details. | [GUST-FONT-LICENSE.txt](GUST-FONT-LICENSE.txt), [LPPL-1.3c.txt](LPPL-1.3c.txt), [README-Latin-Modern-Math.txt](README-Latin-Modern-Math.txt), [MANIFEST-Latin-Modern-Math.txt](MANIFEST-Latin-Modern-Math.txt) | [출처](https://ctan.org/tex-archive/fonts/lm-math) |
| [NanumGothic-Bold.woff2](../NanumGothic-Bold.woff2) | Copyright © 2011 NHN Corporation. All rights reserved. Font designed by Sandoll Communications Inc. | [NanumGothic-OFL.txt](NanumGothic-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/OFL.txt) |
| [NanumGothic-ExtraBold.woff2](../NanumGothic-ExtraBold.woff2) | Copyright © 2011 NHN Corporation. All rights reserved. Font designed by Sandoll Communications Inc. | [NanumGothic-OFL.txt](NanumGothic-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/OFL.txt) |
| [NanumGothic-Regular.woff2](../NanumGothic-Regular.woff2) | Copyright © 2011 NHN Corporation. All rights reserved. Font designed by Sandoll Communications Inc. | [NanumGothic-OFL.txt](NanumGothic-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/OFL.txt) |
| [NanumGothicCoding-Bold.woff2](../NanumGothicCoding-Bold.woff2) | Copyright © 2009 NHN Corporation. All rights reserved. Font designed by Sandoll Communications Inc. | [NanumGothicCoding-OFL.txt](NanumGothicCoding-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothiccoding/OFL.txt) |
| [NanumGothicCoding-Regular.woff2](../NanumGothicCoding-Regular.woff2) | Copyright © 2009 NHN Corporation. All rights reserved. Font designed by Sandoll Communications Inc. | [NanumGothicCoding-OFL.txt](NanumGothicCoding-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothiccoding/OFL.txt) |
| [NanumMyeongjo-Bold.woff2](../NanumMyeongjo-Bold.woff2) | Copyright © 2010 NHN Corporation. All rights reserved. Font designed by FONTRIX. | [NanumMyeongjo-OFL.txt](NanumMyeongjo-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanummyeongjo/OFL.txt) |
| [NanumMyeongjo-ExtraBold.woff2](../NanumMyeongjo-ExtraBold.woff2) | Copyright © 2010 NHN Corporation. All rights reserved. Font designed by FONTRIX. | [NanumMyeongjo-OFL.txt](NanumMyeongjo-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanummyeongjo/OFL.txt) |
| [NanumMyeongjo-Regular.woff2](../NanumMyeongjo-Regular.woff2) | Copyright © 2010 NHN Corporation. All rights reserved. Font designed by FONTRIX. | [NanumMyeongjo-OFL.txt](NanumMyeongjo-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/nanummyeongjo/OFL.txt) |
| [NotoSansKR-Bold.woff2](../NotoSansKR-Bold.woff2) | (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | [NotoSansKR-OFL.txt](NotoSansKR-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt) |
| [NotoSansKR-ExtraLight.woff2](../NotoSansKR-ExtraLight.woff2) | (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | [NotoSansKR-OFL.txt](NotoSansKR-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt) |
| [NotoSansKR-Regular.woff2](../NotoSansKR-Regular.woff2) | (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | [NotoSansKR-OFL.txt](NotoSansKR-OFL.txt) | [출처](https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt) |
| [NotoSerifKR-Bold.woff2](../NotoSerifKR-Bold.woff2) | (c) 2017-2024 Adobe (http://www.adobe.com/). | [NotoSerifKR-LICENSE.txt](NotoSerifKR-LICENSE.txt) | [출처](https://github.com/notofonts/noto-cjk) |
| [NotoSerifKR-Regular.woff2](../NotoSerifKR-Regular.woff2) | (c) 2017-2024 Adobe (http://www.adobe.com/). | [NotoSerifKR-LICENSE.txt](NotoSerifKR-LICENSE.txt) | [출처](https://github.com/notofonts/noto-cjk) |
| [Pretendard-Black.woff2](../Pretendard-Black.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-Bold.woff2](../Pretendard-Bold.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-ExtraBold.woff2](../Pretendard-ExtraBold.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-ExtraLight.woff2](../Pretendard-ExtraLight.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-Light.woff2](../Pretendard-Light.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-Medium.woff2](../Pretendard-Medium.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-Regular.woff2](../Pretendard-Regular.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-SemiBold.woff2](../Pretendard-SemiBold.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [Pretendard-Thin.woff2](../Pretendard-Thin.woff2) | Copyright © 2023 Kil Hyung-jin | [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [출처](https://github.com/orioncactus/pretendard) |
| [SourceHanSerifK-OldHangul-subset.woff2](../SourceHanSerifK-OldHangul-subset.woff2) | © 2017-2024 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | [SourceHanSerifK-LICENSE.txt](SourceHanSerifK-LICENSE.txt) | [출처](https://github.com/adobe-fonts/source-han-serif) |
| [SpoqaHanSans-Regular.woff2](../SpoqaHanSans-Regular.woff2) | Copyright  2015 Spoqa (http://bi.spoqa.com/) | [SpoqaHanSans-LICENSE.txt](SpoqaHanSans-LICENSE.txt) | [출처](https://github.com/spoqa/spoqa-han-sans) |

## 공식 ZIP 대조

아래 6개는 원본 member와 SHA-256이 일치한다. archive SHA-256은 JSON에 별도로 기록했다.

| 파일 | 공식 archive / member | WOFF2 SHA-256 |
|---|---|---|
| Cafe24Ssurround-v2.0.woff2 | [archive](https://img.cafe24.com/csdstatic/freefonts/download/kr/Cafe24Ssurround-v2.0.zip) / `Cafe24Ssurround-v2.0/webfont/Cafe24Ssurround-v2.0.woff2` | `2d726dbf8863d66e6d5cf56e2532c5d14d8a4b514461b565c513c1da6ae2f41a` |
| Cafe24Supermagic-Regular-v1.0.woff2 | [archive](https://img.cafe24.com/csdstatic/freefonts/download/kr/Cafe24Supermagic-Regular-v1.0.zip) / `Cafe24Supermagic-Regular-v1.0/webfont/Cafe24Supermagic-Regular-v1.0.woff2` | `65434a217b9532867a1fe41417d0ad51210a60027a51dca40748aafed48ef0ba` |
| Happiness-Sans-Title.woff2 | [archive](https://thehyundaifont.com/assets/fonts/HappinessSans-Screen.zip) / `screen/webfont/Happiness-Sans-Title.woff2` | `057e6821a062d9192964d99cf058fe6608230e9e4a464c9652b3756e02460e22` |
| Happiness-Sans-Regular.woff2 | [archive](https://thehyundaifont.com/assets/fonts/HappinessSans-Screen.zip) / `screen/webfont/Happiness-Sans-Regular.woff2` | `4fc37e7663c3d440b5a6af6938bde0c6618b666553ed521745f3362050bd4988` |
| HappinessSansVF.woff2 | [archive](https://thehyundaifont.com/assets/fonts/HappinessSans-Screen.zip) / `screen/webfont/HappinessSansVF.woff2` | `cd29de60acf8c466938400561fcbfb14812dd5981f4f78b0c8da74609682423c` |
| Happiness-Sans-Bold.woff2 | [archive](https://thehyundaifont.com/assets/fonts/HappinessSans-Screen.zip) / `screen/webfont/Happiness-Sans-Bold.woff2` | `54becdfd4f7f58e872eba8fbc67778e29cff94c1cd03f9a0ebadfbe482b4aba0` |

## 라이선스 원문의 출처와 해시

| 동봉 원문 | URL / archive member | SHA-256 |
|---|---|---|
| [OFL-1.1.txt](OFL-1.1.txt) | [원문](https://openfontlicense.org/documents/OFL.txt) | `1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e` |
| [Pretendard-LICENSE.txt](Pretendard-LICENSE.txt) | [원문](https://raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE) | `82e9c8a4b203261f10ddba1296422d64914ff3d4b7bd8a12896d03f0f088d70a` |
| [D2Coding-OFL.txt](D2Coding-OFL.txt) | [원문](https://raw.githubusercontent.com/naver/d2-coding-font/master/OFL.txt) | `1807e8dec4d65f474cbf9be39f5e2254ecb81702babc320749e272ea66ffcc69` |
| [SpoqaHanSans-LICENSE.txt](SpoqaHanSans-LICENSE.txt) | [원문](https://raw.githubusercontent.com/spoqa/spoqa-han-sans/master/LICENSE) | `279753543734e7a1846e3cb3f80d4dcdcc91f49c436411adaba82e3913c61cde` |
| [GowunBatang-OFL.txt](GowunBatang-OFL.txt) | [원문](https://raw.githubusercontent.com/google/fonts/main/ofl/gowunbatang/OFL.txt) | `49a57cc769fa9affd6eefb9070a61e3d3f6b757c97cafb15848bc6d1c81acc78` |
| [GowunDodum-OFL.txt](GowunDodum-OFL.txt) | [원문](https://raw.githubusercontent.com/google/fonts/main/ofl/gowundodum/OFL.txt) | `a7c73f9521cd646bbdfb6684c99a62311bbd7bce11898dc11ef0b3c69eda1aca` |
| [NanumGothic-OFL.txt](NanumGothic-OFL.txt) | [원문](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/OFL.txt) | `eeacf16032901d0ed0456876ec77b8f0fda6b3fecec7d972f8543eb602e6c30f` |
| [NanumMyeongjo-OFL.txt](NanumMyeongjo-OFL.txt) | [원문](https://raw.githubusercontent.com/google/fonts/main/ofl/nanummyeongjo/OFL.txt) | `8eb1c1019fe7fe6d0b6e7d7bbbba1d9cbdd969d8c5f26455708f6cfb8a77284c` |
| [NanumGothicCoding-OFL.txt](NanumGothicCoding-OFL.txt) | [원문](https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothiccoding/OFL.txt) | `eeacf16032901d0ed0456876ec77b8f0fda6b3fecec7d972f8543eb602e6c30f` |
| [NotoSansKR-OFL.txt](NotoSansKR-OFL.txt) | [원문](https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt) | `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9` |
| [NotoSerifKR-LICENSE.txt](NotoSerifKR-LICENSE.txt) | [원문](https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/LICENSE) | `6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2` |
| [SourceHanSerifK-LICENSE.txt](SourceHanSerifK-LICENSE.txt) | [원문](https://raw.githubusercontent.com/adobe-fonts/source-han-serif/release/LICENSE.txt) | `9ff5bb567e1b92c801fc1069e5fbf992ff8efccacb9db94e5959a5b3ba9bb903` |
| [GUST-FONT-LICENSE.txt](GUST-FONT-LICENSE.txt) | [원문](https://mirrors.ibiblio.org/CTAN/fonts/lm-math/doc/GUST-FONT-LICENSE.txt) | `2bd69affc3da00715116f713f57eab9707e96daf3562ad0215987b15b9c16f73` |
| [LPPL-1.3c.txt](LPPL-1.3c.txt) | [원문](https://www.latex-project.org/lppl/lppl-1-3c.txt) | `3d262cdf34dafa6955f703c634a8c238ec44109bc8dd6ef34fb7aa54809f7e66` |
| [README-Latin-Modern-Math.txt](README-Latin-Modern-Math.txt) | [원문](https://mirrors.ibiblio.org/CTAN/fonts/lm-math/doc/README-Latin-Modern-Math.txt) | `e6fdd5fb44b656146fa988d191f58901c09a347d3f4fbaa3b45b24a6ad7ec30b` |
| [MANIFEST-Latin-Modern-Math.txt](MANIFEST-Latin-Modern-Math.txt) | [원문](https://mirrors.ibiblio.org/CTAN/fonts/lm-math/doc/MANIFEST-Latin-Modern-Math.txt) | `1daa729f7922c42ba5ce8da7dfe4ecdc9e5c878ad86217fd6f32c4671505b007` |
| [License-Ssurround.pdf](License-Ssurround.pdf) | [원문](https://img.cafe24.com/csdstatic/freefonts/download/kr/Cafe24Ssurround-v2.0.zip) / `Cafe24Ssurround-v2.0/License-Ssurround.pdf` | `de2158b3dc8aa27513451108fb09088f9afd8fce1d65c2cac29c7e554b37a7d9` |
| [License-Supermagic.pdf](License-Supermagic.pdf) | [원문](https://img.cafe24.com/csdstatic/freefonts/download/kr/Cafe24Supermagic-Regular-v1.0.zip) / `Cafe24Supermagic-Regular-v1.0/License-Supermagic.pdf` | `bdf5e278410f73faaf5a34db9ad4ce328cabd673d8f699bd986869a690193511` |
| [HapinessSans_License.pdf](HapinessSans_License.pdf) | [원문](https://thehyundaifont.com/assets/fonts/HappinessSans-Screen.zip) / `screen/HapinessSans_License.pdf` | `f5bd344131ee034f3425517ea376ab6acea9126310e7b2cd74cd18673991b055` |

## 해피니스 산스

공식 PDF는 SIL OFL 1.1 전문과 현대백화점의 사용 안내를 포함한다. PDF의 ©2021 Hyundai Department Store Group,
글꼴의 ©2022 THE HYUNDAI 고지를 모두 보존한다. 원본 WOFF2 4개는 수정본이 아니다.
fixture 원본 바이트 유지 정책을 라이선스상 모든 수정 금지로 해석하지 않는다.

## Latin Modern Math

현재 WOFF2는 내장 버전 1.959이며 ©2012–2014 B. Jackowski, P. Strzelczyk, P. Pianowski를 표시한다.
GUST 라이선스는 LPPL 1.3c 이상 조건을 적용한다. 원본 [README](README-Latin-Modern-Math.txt),
[MANIFEST](MANIFEST-Latin-Modern-Math.txt), [GUST](GUST-FONT-LICENSE.txt), [LPPL](LPPL-1.3c.txt)을 동봉한다.
원본 전체 배포본은 [CTAN lm-math](https://ctan.org/tex-archive/fonts/lm-math)에서 얻을 수 있다.
현재 WOFF2를 만든 정확한 변환 이력은 이번 조사에서 재현하지 않았다. 변환본 고지는 실제 확인된 변경만 추가해야 한다.

## LIDGE Old Hangul Serif: 이름 변경 및 보존 검증 완료

Source Han Serif K의 옛한글 subset을 `LIDGE Old Hangul Serif`로 명명한 파생본이다.
WOFF2와 OTF의 family/full name은 `LIDGE Old Hangul Serif`, PostScript name은
`LIDGEOldHangulSerif-Regular`이며 CFF의 primary names도 일관되게 변경했다.
원저작권·OFL·출처·trademark 고지는 보존했다. 기존 파일명은 URL·fixture 경로 호환을 위해 유지한다.

원본은 Adobe Source Han Serif K이며 `Source`는 Reserved Font Name이다.
[upstream 변환 설명](https://raw.githubusercontent.com/edwardkim/rhwp/main/mydocs/tech/font_fallback_strategy.md)의
§10.3은 원본 OTF를 `pyftsubset`으로 옛한글 자모 영역에 한정하는 절차다.
[OFL 웹폰트·RFN 안내](https://openfontlicense.org/webfonts-and-reserved-font-names/)에 따라
그 파생본의 내부 primary name을 바꿨다. 원저작자의 별도 RFN 사용 허가를 주장하지 않는다.

| 자산 | 변경 전 SHA-256 | 현재 SHA-256 | 현재 bytes |
|---|---|---|---|
| `assets/fonts/SourceHanSerifK-OldHangul-subset.woff2` | `9e419cd16df2ea3b220aa7751320d956ac2493440ba412484d98325078f09d43` | `b58cb0f0ab1c354afd61597f55d816a579344babe3b49826d6927f2792ff3ae9` | 239900 |
| `ttfs/opensource/SourceHanSerifK-OldHangul-subset.otf` | `2f86ef9a52acb6d1dad9d915843239123b635d97edd88fd0573a88ffcb4e16f1` | `f130fc3542fc77284b6520a2ff162a9f11a66d8d1789aae74850b8412995c466` | 456680 |

검증: 2026-09-27, 저장소 루트에서 아래 읽기 전용 명령을 실행해 `PASS`를 확인했다.
fontTools 4.62.1과 Brotli 1.2.0은 재현·검증 도구이며 제품 runtime 의존성이 아니다.

```sh
python scripts/rename-sourcehan-subset.py --check
```

[재현·검증 스크립트](../../../../scripts/rename-sourcehan-subset.py)는 변경 전 자산에서 고정한
invariant digest `cb69fd41bfd966a28ce614a44e9786283dc45d696decc1b98e69f9633598e6cd`와 대조한다.
2,215개 glyph와 outline·glyph order·cmap(357 Unicode mapping)·hmtx·vmtx·GSUB·GPOS,
CharStrings/subroutine, 비이름 테이블, 원저작권·고지 기록이 보존됨을 확인했다.
WOFF2와 OTF의 SFNT 데이터 일치 및 재직렬화 idempotence도 통과했다.
현재·변경 전 이름과 해시, 세부 invariant 값은 [JSON](font-inventory.json)에 있다.

웹 로더가 사용하는 기존 CSS alias와 파일 URL은 호환용으로 유지되며, 글꼴 내부 primary name과 구분한다.
이 고지는 이름 변경과 비이름 데이터 보존의 검증 결과이며 별도 브라우저 시각 검증을 대신하지 않는다.
