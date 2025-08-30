#!/bin/bash

echo "A2A Interactive Client Launcher"
echo "==============================="
echo ""
echo "Choose a server to connect to:"
echo "1) Localhost (http://localhost:3003) - requires active room ID"
echo "2) Banterop FHIR (Knee MRI scenario)"
echo "3) Custom URL"
echo ""
read -p "Enter choice (1-3): " choice

case $choice in
    1)
        echo "Enter the room ID (e.g., please-replace-this-placeholder-1756426027739-gvr0wy):"
        read room_id
        URL="http://localhost:3003/api/rooms/${room_id}/a2a"
        ;;
    2)
        URL="https://banterop.fhir.me/api/bridge/eyJ0aXRsZSI6IlJ1bjogS25lZSBNUkkgUHJpb3IgQXV0aCIsInNjZW5hcmlvSWQiOiJzY2VuX2tuZWVfbXJpXzAxIiwiYWdlbnRzIjpbeyJpZCI6InBhdGllbnQtYWdlbnQifSx7ImlkIjoiaW5zdXJhbmNlLWF1dGgtc3BlY2lhbGlzdCIsImNvbmZpZyI6eyJtb2RlbCI6Im9wZW5haS9ncHQtb3NzLTEyMGI6bml0cm8ifX1dLCJzdGFydGluZ0FnZW50SWQiOiJwYXRpZW50LWFnZW50In0/a2a"
        ;;
    3)
        echo "Enter the A2A server URL:"
        read URL
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "Connecting to: $URL"
echo ""

source .venv/bin/activate
python a2a_client.py "$URL"