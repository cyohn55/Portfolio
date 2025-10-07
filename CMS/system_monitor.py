#!/usr/bin/env python3
"""
Email-to-Portfolio System Monitor
Ensures 100% reliability by monitoring system health and detecting issues
"""

import os
import sys
import json
import logging
import requests
from datetime import datetime, timedelta
from typing import Dict, List, Optional

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class SystemMonitor:
    def __init__(self):
        self.github_repo = "cyohn55/Portfolio"
        self.github_api_base = f"https://api.github.com/repos/{self.github_repo}"
        self.processed_emails_file = os.path.join(os.path.dirname(__file__), 'processed_emails_cloud.json')
        
    def check_github_secrets(self) -> Dict[str, bool]:
        """Check if required GitHub secrets are configured"""
        required_secrets = ['GMAIL_USERNAME', 'GMAIL_PASSWORD', 'AUTHORIZED_SENDER']
        secrets_status = {}
        
        for secret in required_secrets:
            # In GitHub Actions, secrets are available as environment variables
            # Locally, they won't be available (which is expected)
            secrets_status[secret] = os.getenv(secret) is not None
            
        return secrets_status
    
    def check_workflow_status(self) -> Dict[str, any]:
        """Check recent GitHub Actions workflow runs"""
        try:
            url = f"{self.github_api_base}/actions/workflows/email-to-portfolio.yml/runs"
            response = requests.get(url, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                runs = data.get('workflow_runs', [])
                
                if not runs:
                    return {'status': 'no_runs', 'message': 'No workflow runs found'}
                
                recent_run = runs[0]
                return {
                    'status': recent_run['status'],
                    'conclusion': recent_run.get('conclusion'),
                    'created_at': recent_run['created_at'],
                    'run_number': recent_run['run_number'],
                    'html_url': recent_run['html_url']
                }
            else:
                return {'status': 'api_error', 'code': response.status_code}
                
        except Exception as e:
            return {'status': 'error', 'message': str(e)}
    
    def check_recent_processing(self) -> Dict[str, any]:
        """Check if emails have been processed recently"""
        try:
            if not os.path.exists(self.processed_emails_file):
                return {'status': 'no_file', 'message': 'No processed emails file found'}
            
            with open(self.processed_emails_file, 'r') as f:
                processed_emails = json.load(f)
            
            if not processed_emails:
                return {'status': 'empty', 'message': 'No emails processed yet'}
            
            return {
                'status': 'active',
                'total_processed': len(processed_emails),
                'message': f'{len(processed_emails)} emails processed successfully'
            }
            
        except Exception as e:
            return {'status': 'error', 'message': str(e)}
    
    def check_email_connectivity(self) -> Dict[str, any]:
        """Test email server connectivity"""
        import imaplib
        
        username = os.getenv('GMAIL_USERNAME', 'email.to.portfolio.site@gmail.com')
        password = os.getenv('GMAIL_PASSWORD')
        
        if not password:
            return {'status': 'no_password', 'message': 'Gmail password not configured'}
        
        try:
            mail = imaplib.IMAP4_SSL('imap.gmail.com', 993)
            mail.login(username, password)
            mail.select('inbox')
            mail.logout()
            
            return {'status': 'connected', 'message': 'Gmail connection successful'}
            
        except Exception as e:
            return {'status': 'failed', 'message': f'Gmail connection failed: {str(e)}'}
    
    def generate_system_report(self) -> Dict[str, any]:
        """Generate comprehensive system health report"""
        report = {
            'timestamp': datetime.now().isoformat(),
            'overall_status': 'unknown',
            'checks': {}
        }
        
        # Check secrets configuration
        secrets_status = self.check_github_secrets()
        secrets_configured = all(secrets_status.values())
        report['checks']['secrets'] = {
            'status': 'configured' if secrets_configured else 'missing',
            'details': secrets_status
        }
        
        # Check workflow status
        workflow_status = self.check_workflow_status()
        report['checks']['workflow'] = workflow_status
        
        # Check recent processing
        processing_status = self.check_recent_processing()
        report['checks']['processing'] = processing_status
        
        # Check email connectivity (only if secrets are available)
        if secrets_configured:
            email_status = self.check_email_connectivity()
            report['checks']['email_connectivity'] = email_status
        else:
            report['checks']['email_connectivity'] = {
                'status': 'skipped',
                'message': 'Secrets not configured'
            }
        
        # Determine overall status
        if not secrets_configured:
            report['overall_status'] = 'secrets_missing'
        elif workflow_status.get('status') == 'completed' and workflow_status.get('conclusion') == 'success':
            report['overall_status'] = 'healthy'
        elif workflow_status.get('status') == 'in_progress':
            report['overall_status'] = 'running'
        else:
            report['overall_status'] = 'issues_detected'
        
        return report
    
    def print_system_status(self):
        """Print formatted system status report"""
        report = self.generate_system_report()
        
        print("🔍 EMAIL-TO-PORTFOLIO SYSTEM MONITOR")
        print("=" * 50)
        print(f"⏰ Report Time: {report['timestamp']}")
        print(f"📊 Overall Status: {report['overall_status'].upper()}")
        print()
        
        # Status indicators
        status_icons = {
            'healthy': '✅',
            'running': '🔄',
            'issues_detected': '⚠️',
            'secrets_missing': '❌'
        }
        
        icon = status_icons.get(report['overall_status'], '❓')
        print(f"{icon} SYSTEM STATUS: {report['overall_status'].replace('_', ' ').title()}")
        print()
        
        # Detailed checks
        checks = report['checks']
        
        print("📋 DETAILED CHECKS:")
        print("-" * 30)
        
        # Secrets check
        secrets = checks['secrets']
        secrets_icon = '✅' if secrets['status'] == 'configured' else '❌'
        print(f"{secrets_icon} GitHub Secrets: {secrets['status'].upper()}")
        for secret, configured in secrets['details'].items():
            secret_icon = '✅' if configured else '❌'
            print(f"   {secret_icon} {secret}")
        print()
        
        # Workflow check
        workflow = checks['workflow']
        if workflow['status'] == 'completed':
            if workflow.get('conclusion') == 'success':
                workflow_icon = '✅'
                status_text = 'SUCCESSFUL'
            else:
                workflow_icon = '❌'
                status_text = f"FAILED ({workflow.get('conclusion', 'unknown')})"
        elif workflow['status'] == 'in_progress':
            workflow_icon = '🔄'
            status_text = 'RUNNING'
        else:
            workflow_icon = '⚠️'
            status_text = workflow['status'].upper()
        
        print(f"{workflow_icon} GitHub Actions: {status_text}")
        if 'run_number' in workflow:
            print(f"   📊 Latest Run: #{workflow['run_number']}")
            print(f"   🔗 URL: {workflow.get('html_url', 'N/A')}")
        print()
        
        # Processing check
        processing = checks['processing']
        processing_icon = '✅' if processing['status'] == 'active' else '⚠️'
        print(f"{processing_icon} Email Processing: {processing['status'].upper()}")
        print(f"   📧 {processing['message']}")
        print()
        
        # Email connectivity check
        if 'email_connectivity' in checks:
            email = checks['email_connectivity']
            email_icon = '✅' if email['status'] == 'connected' else '❌'
            print(f"{email_icon} Gmail Connection: {email['status'].upper()}")
            print(f"   📬 {email['message']}")
        
        print()
        print("=" * 50)
        
        # Recommendations
        if report['overall_status'] == 'secrets_missing':
            print("🎯 IMMEDIATE ACTION REQUIRED:")
            print("   Configure GitHub Secrets to activate the system")
            print("   URL: https://github.com/cyohn55/Portfolio/settings/secrets/actions")
        elif report['overall_status'] == 'healthy':
            print("🎉 SYSTEM OPERATIONAL:")
            print("   Email-to-portfolio system is working correctly")
            print("   Send emails to email.to.portfolio.site@gmail.com")
        elif report['overall_status'] == 'issues_detected':
            print("⚠️  ISSUES DETECTED:")
            print("   Check GitHub Actions logs for error details")
            print("   URL: https://github.com/cyohn55/Portfolio/actions")

def main():
    """Run system monitor"""
    monitor = SystemMonitor()
    monitor.print_system_status()

if __name__ == "__main__":
    main() 