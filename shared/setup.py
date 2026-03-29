from setuptools import find_packages, setup

setup(
    name="shared",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "pydantic>=2.0.0",
        "google-cloud-firestore>=2.16.0",
        "timezonefinder>=6.0.0",
    ],
    python_requires=">=3.12",
)
