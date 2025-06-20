#!/usr/bin/env python3
"""
Test Wake Commands
Test script to verify wake command detection and parsing
"""

from wake_controller import wake_controller

def test_wake_commands():
    """Test various wake command formats"""
    
    test_cases = [
        # Basic wake up
        ("[Wake Up]", "Should detect wake_once"),
        ("[WAKE UP]", "Case insensitive test"),
        ("[wake up]", "Lowercase test"),
        
        # Wake up every X minutes
        ("[Wake Up] every 5 minutes", "Should detect wake_frequent with 5 minute interval"),
        ("[Wake Up] every 10 mins", "Should detect wake_frequent with 10 minute interval"),
        ("[Wake Up] every 2 hours", "Should detect wake_frequent with 120 minute interval"),
        ("[Wake Up] every 1 hour", "Should detect wake_frequent with 60 minute interval"),
        
        # Stay awake for X time
        ("[Wake Up] for 30 minutes", "Should detect stay_awake for 30 minutes"),
        ("[Wake Up] for 2 hours", "Should detect stay_awake for 120 minutes"),
        ("[Wake Up] for 1 hr", "Should detect stay_awake for 60 minutes"),
        
        # Natural language "for the next" patterns
        ("[Wake Up] for the next hour", "Should detect stay_awake for 60 minutes"),
        ("[Wake Up] for the next 2 hours", "Should detect stay_awake for 120 minutes"),
        ("[Wake Up] for the next 30 minutes", "Should detect stay_awake for 30 minutes"),
        ("[Wake Up] for the next minute", "Should detect stay_awake for 1 minute"),
        
        # Invalid/unrecognized
        ("Regular email subject", "Should not detect any wake command"),
        ("[Wake Up] some weird text", "Should default to wake_once"),
        ("Meeting about [Wake Up]", "Should not detect (not at start)"),
    ]
    
    print("🧪 Testing Wake Command Detection")
    print("=" * 50)
    
    for subject, description in test_cases:
        print(f"\n📧 Subject: '{subject}'")
        print(f"📝 Expected: {description}")
        
        result = wake_controller.detect_wake_command(subject, "")
        
        if result:
            print(f"✅ Detected: {result['type']} - {result['description']}")
            if 'interval_minutes' in result:
                print(f"   ⏰ Interval: {result['interval_minutes']} minutes")
            if 'duration_minutes' in result:
                print(f"   ⏱️  Duration: {result['duration_minutes']} minutes")
        else:
            print("❌ No wake command detected")
    
    print("\n" + "=" * 50)
    print("🎯 Test completed!")

if __name__ == "__main__":
    test_wake_commands() 