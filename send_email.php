

<?php
$to      = 'cyohn55@yahoo.com';
$subject = 'Test Email';
$message = 'This is a test email to check if PHP mail function works.';
$headers = 'From: test@example.com' . "\r\n" .
           'Reply-To: test@example.com' . "\r\n" .
           'X-Mailer: PHP/' . phpversion();

if (mail($to, $subject, $message, $headers)) {
    echo 'Email sent successfully.';
} else {
    echo 'Email sending failed.';
}
?>
