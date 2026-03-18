#!/bin/bash

# Scheduler GitHub Deployment Script
# Created by Antigravity

REPO_NAME="scheduler"
USER_NAME="khcho21"

echo "🚀 Scheduler 앱 배포를 시작합니다..."

# 1. GitHub CLI(gh) 설치 확인 및 로그인 시도
if ! command -v gh &> /dev/null
then
    echo "❌ GitHub CLI(gh)가 설치되어 있지 않습니다. 표준 git 명령어로 진행합니다."
    echo "먼저 GitHub 사이트에서 'scheduler'라는 이름의 저장소를 생성해 주세요."
    echo "주소: https://github.com/new"
else
    echo "✅ GitHub CLI가 감지되었습니다. 저장소 자동 생성을 시도합니다."
    # 이미 존재하는지 확인 후 생성
    if gh repo view $USER_NAME/$REPO_NAME >/dev/null 2>&1; then
        echo "ℹ️ 이미 온라인에 저장소가 존재합니다. 업데이트를 진행합니다."
    else
        gh repo create $REPO_NAME --public --source=. --remote=origin --push
        if [ $? -eq 0 ]; then
            echo "✅ 저장소 생성 및 푸시 완료!"
            echo "🔗 주소: https://github.com/$USER_NAME/$REPO_NAME"
            echo "이제 GitHub 사이트 [Settings] -> [Pages]에서 'main' 브랜디를 선택해 주세요."
            exit 0
        fi
    fi
fi

# 2. 표준 Git 명령어로 원격 저장소 연결 및 푸시 (gh 없을 경우)
echo "🔗 원격 저장소 연결을 시도합니다..."
git remote remove origin >/dev/null 2>&1
git remote add origin https://github.com/$USER_NAME/$REPO_NAME.git
git branch -M main

echo "📤 코드를 푸시합니다. 로그인 창이 뜨면 GitHub 로그인을 진행해 주세요."
git push -u origin main

echo ""
echo "🎉 작업이 완료되었습니다!"
echo "GitHub 저장소 설정(Settings -> Pages)에서 'main' 브랜드를 빌드 대상으로 선택하면 휴대폰에서도 접속 가능합니다."
echo "도움이 필요하시면 말씀해 주세요!"
