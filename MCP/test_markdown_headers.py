#!/usr/bin/env python3
"""Test script to verify markdown header processing works correctly"""

from simple_email_processor import markdown_to_html

def test_markdown_headers():
    """Test various markdown header scenarios"""
    
    # Test 1: Simple ### header
    test1 = "### This is a heading 3"
    result1 = markdown_to_html(test1)
    print("Test 1 - Simple ### header:")
    print(f"Input: '{test1}'")
    print(f"Output: '{result1}'")
    print()
    
    # Test 2: ### header with text after
    test2 = "### This is a heading 3\nThis is some text after the header."
    result2 = markdown_to_html(test2)
    print("Test 2 - ### header with text:")
    print(f"Input: '{test2}'")
    print(f"Output: '{result2}'")
    print()
    
    # Test 3: Mixed content with ### header
    test3 = "Some text before.\n\n### This is a heading 3\nSome text after the header."
    result3 = markdown_to_html(test3)
    print("Test 3 - Mixed content with ### header:")
    print(f"Input: '{test3}'")
    print(f"Output: '{result3}'")
    print()
    
    # Test 4: Alignment tag with ### header
    test4 = "[center] ### Centered heading"
    result4 = markdown_to_html(test4)
    print("Test 4 - Alignment tag with ### header:")
    print(f"Input: '{test4}'")
    print(f"Output: '{result4}'")
    print()

if __name__ == "__main__":
    test_markdown_headers() 